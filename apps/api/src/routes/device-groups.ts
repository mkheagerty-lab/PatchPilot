import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tables,
  demoDevices,
  demoDeviceGroups,
  demoDeviceGroupMembers,
  type DeviceGroupRow,
  type DeviceGroupMemberRow,
  type DeviceRow,
} from "@patchpilot/db";
import { audit } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * PatchPilot-native device groups — an engineer-curated grouping used to scope
 * recurring schedule fan-out to a subset of a tenant's devices.
 *
 * Deliberately distinct from `devices.deviceGroupId`/`deviceGroupName`, which
 * is Defender's own read-only RBAC machine group synced in from `/machines`:
 * that one can't be created or edited from PatchPilot and isn't scoped to
 * remediation. This table is created, renamed and populated entirely here.
 *
 * Structurally a close copy of device-exclusions.ts — same DEMO_MODE branch
 * shape, same managedDeviceId-keyed membership (not a devices.id uuid FK),
 * for the same reason: syncDevices() hard-deletes/upserts device rows every
 * sync, so a uuid FK would orphan. See the schema comment on deviceExclusions.
 */

/** The devices being added, so the hostname snapshot is ours and not the client's. */
async function loadDevicesForGroup(
  tenantId: string,
  managedDeviceIds: string[],
): Promise<DeviceRow[]> {
  if (config.DEMO_MODE) {
    return demoDevices.filter(
      (d) => d.tenantId === tenantId && managedDeviceIds.includes(d.managedDeviceId),
    );
  }
  return db
    .select()
    .from(tables.devices)
    .where(
      and(
        eq(tables.devices.tenantId, tenantId),
        inArray(tables.devices.managedDeviceId, managedDeviceIds),
      ),
    );
}

async function loadGroup(tenantId: string, id: string): Promise<DeviceGroupRow | undefined> {
  if (config.DEMO_MODE) {
    return demoDeviceGroups.find((g) => g.id === id && g.tenantId === tenantId);
  }
  const [row] = await db
    .select()
    .from(tables.deviceGroups)
    .where(and(eq(tables.deviceGroups.id, id), eq(tables.deviceGroups.tenantId, tenantId)));
  return row;
}

/** Every member of a group — used by the members panel and by schedule fan-out. */
export async function loadDeviceGroupMembership(
  tenantId: string,
  deviceGroupId: string,
): Promise<DeviceGroupMemberRow[]> {
  if (config.DEMO_MODE) {
    return demoDeviceGroupMembers.filter(
      (m) => m.tenantId === tenantId && m.deviceGroupId === deviceGroupId,
    );
  }
  return db
    .select()
    .from(tables.deviceGroupMembers)
    .where(
      and(
        eq(tables.deviceGroupMembers.tenantId, tenantId),
        eq(tables.deviceGroupMembers.deviceGroupId, deviceGroupId),
      ),
    );
}

export async function deviceGroupsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  app.get<{ Querystring: { tenantId?: string } }>("/api/local-device-groups", async (req, reply) => {
    const { tenantId } = req.query;
    if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

    const groups = config.DEMO_MODE
      ? demoDeviceGroups.filter((g) => g.tenantId === tenantId)
      : await db.select().from(tables.deviceGroups).where(eq(tables.deviceGroups.tenantId, tenantId));

    const members = config.DEMO_MODE
      ? demoDeviceGroupMembers.filter((m) => m.tenantId === tenantId)
      : await db
          .select()
          .from(tables.deviceGroupMembers)
          .where(eq(tables.deviceGroupMembers.tenantId, tenantId));

    const countByGroup = new Map<string, number>();
    for (const m of members) countByGroup.set(m.deviceGroupId, (countByGroup.get(m.deviceGroupId) ?? 0) + 1);

    return [...groups]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ ...g, memberCount: countByGroup.get(g.id) ?? 0 }));
  });

  app.get<{ Params: { id: string }; Querystring: { tenantId?: string } }>(
    "/api/local-device-groups/:id/members",
    async (req, reply) => {
      const { tenantId } = req.query;
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      const group = await loadGroup(tenantId, req.params.id);
      if (!group) return reply.code(404).send({ error: "not_found" });
      const members = await loadDeviceGroupMembership(tenantId, req.params.id);
      return members.sort((a, b) => a.deviceHostname.localeCompare(b.deviceHostname));
    },
  );

  interface CreateGroupBody {
    tenantId?: string;
    name?: string;
    description?: string;
  }

  app.post<{ Body: CreateGroupBody }>(
    "/api/local-device-groups",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId, name } = req.body ?? {};
      if (!tenantId || !name?.trim()) {
        return reply.code(400).send({ error: "tenantId and name are required" });
      }

      const existing = config.DEMO_MODE
        ? demoDeviceGroups.find((g) => g.tenantId === tenantId && g.name === name.trim())
        : (
            await db
              .select()
              .from(tables.deviceGroups)
              .where(and(eq(tables.deviceGroups.tenantId, tenantId), eq(tables.deviceGroups.name, name.trim())))
          )[0];
      if (existing) return reply.code(409).send({ error: "a group with this name already exists" });

      const engineer = req.session.engineer!.upn;
      const now = new Date();
      const row: DeviceGroupRow = {
        id: randomUUID(),
        tenantId,
        name: name.trim(),
        description: req.body?.description?.trim() || null,
        createdBy: engineer,
        createdAt: now,
        updatedAt: now,
      };

      if (config.DEMO_MODE) {
        demoDeviceGroups.unshift(row);
      } else {
        await db.insert(tables.deviceGroups).values(row);
      }

      await audit({
        engineer,
        tenantId,
        endpoint: "device-group:create",
        method: "POST",
        action: "device-group:create",
        resourceType: "device-group",
        resourceId: row.id,
        resourceLabel: row.name,
        summary: `Created device group "${row.name}"`,
        outcome: "success",
        payload: { name: row.name },
        responseStatus: 201,
      });

      return reply.code(201).send({ ...row, memberCount: 0 });
    },
  );

  interface UpdateGroupBody {
    tenantId?: string;
    name?: string;
    description?: string | null;
  }

  app.put<{ Params: { id: string }; Body: UpdateGroupBody }>(
    "/api/local-device-groups/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId, name } = req.body ?? {};
      if (!tenantId || !name?.trim()) {
        return reply.code(400).send({ error: "tenantId and name are required" });
      }
      const group = await loadGroup(tenantId, req.params.id);
      if (!group) return reply.code(404).send({ error: "not_found" });

      const engineer = req.session.engineer!.upn;
      const now = new Date();
      const description = req.body?.description?.trim() || null;

      if (config.DEMO_MODE) {
        group.name = name.trim();
        group.description = description;
        group.updatedAt = now;
      } else {
        await db
          .update(tables.deviceGroups)
          .set({ name: name.trim(), description, updatedAt: now })
          .where(eq(tables.deviceGroups.id, req.params.id));
      }

      await audit({
        engineer,
        tenantId,
        endpoint: "device-group:update",
        method: "PUT",
        action: "device-group:update",
        resourceType: "device-group",
        resourceId: req.params.id,
        resourceLabel: name.trim(),
        summary: `Updated device group "${name.trim()}"`,
        outcome: "success",
        payload: { name: name.trim() },
        responseStatus: 200,
      });

      return { ...group, name: name.trim(), description, updatedAt: now };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { tenantId?: string } }>(
    "/api/local-device-groups/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId } = req.query;
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      const group = await loadGroup(tenantId, req.params.id);
      if (!group) return reply.code(404).send({ error: "not_found" });

      if (config.DEMO_MODE) {
        const groupIdx = demoDeviceGroups.findIndex((g) => g.id === req.params.id);
        if (groupIdx >= 0) demoDeviceGroups.splice(groupIdx, 1);
        for (let i = demoDeviceGroupMembers.length - 1; i >= 0; i--) {
          if (demoDeviceGroupMembers[i]?.deviceGroupId === req.params.id) demoDeviceGroupMembers.splice(i, 1);
        }
      } else {
        // Cascade: membership rows have no FK (join-table pattern used
        // throughout this codebase carries no cross-table constraints), so the
        // members delete is explicit rather than relying on ON DELETE CASCADE.
        await db.delete(tables.deviceGroupMembers).where(eq(tables.deviceGroupMembers.deviceGroupId, req.params.id));
        await db.delete(tables.deviceGroups).where(eq(tables.deviceGroups.id, req.params.id));
      }

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId,
        endpoint: "device-group:delete",
        method: "DELETE",
        action: "device-group:delete",
        resourceType: "device-group",
        resourceId: req.params.id,
        resourceLabel: group.name,
        summary: `Deleted device group "${group.name}"`,
        outcome: "success",
        payload: { id: req.params.id },
        responseStatus: 200,
      });

      return reply.code(204).send();
    },
  );

  interface AddMembersBody {
    tenantId?: string;
    managedDeviceIds?: string[];
  }

  app.post<{ Params: { id: string }; Body: AddMembersBody }>(
    "/api/local-device-groups/:id/members",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId, managedDeviceIds } = req.body ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      if (!managedDeviceIds?.length) {
        return reply.code(400).send({ error: "at least one managedDeviceId is required" });
      }
      const group = await loadGroup(tenantId, req.params.id);
      if (!group) return reply.code(404).send({ error: "not_found" });

      const existingMembers = await loadDeviceGroupMembership(tenantId, req.params.id);
      const existingIds = new Set(existingMembers.map((m) => m.managedDeviceId));
      const toAdd = managedDeviceIds.filter((id) => !existingIds.has(id));

      const devices = await loadDevicesForGroup(tenantId, toAdd);
      const engineer = req.session.engineer!.upn;
      const now = new Date();
      const rows: DeviceGroupMemberRow[] = devices.map((d) => ({
        id: randomUUID(),
        tenantId,
        deviceGroupId: req.params.id,
        managedDeviceId: d.managedDeviceId,
        deviceHostname: d.hostname,
        addedBy: engineer,
        addedAt: now,
      }));

      if (rows.length > 0) {
        if (config.DEMO_MODE) {
          demoDeviceGroupMembers.push(...rows);
        } else {
          await db.insert(tables.deviceGroupMembers).values(rows);
        }

        await audit({
          engineer,
          tenantId,
          endpoint: "device-group:add-members",
          method: "POST",
          action: "device-group:add-members",
          resourceType: "device-group",
          resourceId: req.params.id,
          resourceLabel: group.name,
          summary: `Added ${rows.length} device(s) to group "${group.name}"`,
          outcome: "success",
          payload: { managedDeviceIds: rows.map((r) => r.managedDeviceId) },
          responseStatus: 201,
        });
      }

      return reply.code(201).send({
        added: rows.length,
        // Requested but already a member, or no longer in the fleet.
        skipped: managedDeviceIds.length - rows.length,
      });
    },
  );

  app.delete<{ Params: { id: string; managedDeviceId: string }; Querystring: { tenantId?: string } }>(
    "/api/local-device-groups/:id/members/:managedDeviceId",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId } = req.query;
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      const group = await loadGroup(tenantId, req.params.id);
      if (!group) return reply.code(404).send({ error: "not_found" });

      const engineer = req.session.engineer!.upn;

      if (config.DEMO_MODE) {
        const idx = demoDeviceGroupMembers.findIndex(
          (m) => m.deviceGroupId === req.params.id && m.managedDeviceId === req.params.managedDeviceId,
        );
        if (idx < 0) return reply.code(404).send({ error: "not_found" });
        const [removed] = demoDeviceGroupMembers.splice(idx, 1);
        if (!removed) return reply.code(404).send({ error: "not_found" });
        await audit({
          engineer,
          tenantId,
          endpoint: "device-group:remove-member",
          method: "DELETE",
          action: "device-group:remove-member",
          resourceType: "device-group",
          resourceId: req.params.id,
          resourceLabel: group.name,
          summary: `Removed ${removed.deviceHostname} from group "${group.name}"`,
          outcome: "success",
          payload: { managedDeviceId: req.params.managedDeviceId },
          responseStatus: 200,
        });
        return reply.code(204).send();
      }

      const [removed] = await db
        .delete(tables.deviceGroupMembers)
        .where(
          and(
            eq(tables.deviceGroupMembers.deviceGroupId, req.params.id),
            eq(tables.deviceGroupMembers.managedDeviceId, req.params.managedDeviceId),
          ),
        )
        .returning();
      if (!removed) return reply.code(404).send({ error: "not_found" });

      await audit({
        engineer,
        tenantId,
        endpoint: "device-group:remove-member",
        method: "DELETE",
        action: "device-group:remove-member",
        resourceType: "device-group",
        resourceId: req.params.id,
        resourceLabel: group.name,
        summary: `Removed ${removed.deviceHostname} from group "${group.name}"`,
        outcome: "success",
        payload: { managedDeviceId: req.params.managedDeviceId },
        responseStatus: 200,
      });

      return reply.code(204).send();
    },
  );
}
