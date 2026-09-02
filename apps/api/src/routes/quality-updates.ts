import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, tables, type IntuneAssignmentSummary } from "@patchpilot/db";
import { CHANNEL_SPECS } from "@patchpilot/shared";
import {
  audit,
  GraphError,
  listQualityUpdateCatalogItems,
  parseReleaseCadence,
  parseReleaseDate,
  createAndAssignQualityUpdateProfile,
  deleteQualityUpdateProfile,
} from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { resolveAssignmentTargets } from "../services/win32-app-deploy.js";

/**
 * Quality Updates tab routes for the Windows Updates hub. Reads
 * `quality_update_campaigns` — one table holding both `policyType`s
 * (`"expedite"` and `"quality-update"`), kept in sync live by
 * `syncQualityUpdateProfiles`/`syncQualityUpdatePolicies` (apps/api/src/graph/sync.ts).
 * Only `"expedite"` rows have a PatchPilot write path (create/delete) — the
 * `"quality-update"` policyType has no equivalent Graph write in this codebase,
 * so any row of that type is rejected out of the write routes below.
 *
 * Distinct from `POST /api/missing-kbs/quality-update-campaigns`
 * (missing-kbs.ts), which stays live for the Missing KBs "Fix All" flow: that
 * route is KB-first (a specific Defender missing-KB drives the release
 * match), while `POST /api/quality-updates/campaigns` here is a standalone
 * release-first picker with no KB requirement.
 */

function idList(items: readonly string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} + ${items.length - max} more`;
}

interface CreateExpediteBody {
  tenantId?: string;
  displayName?: string;
  catalogItemId?: string;
  releaseLabel?: string;
  daysUntilForcedReboot?: number;
  groupId?: string;
  groupName?: string;
  excludeGroupId?: string;
  excludeGroupName?: string;
}

export async function qualityUpdatesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  /** Both policyTypes together — a live-synced local mirror, not a Graph read. */
  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/quality-updates/campaigns",
    { preHandler: requirePermission("operations:read") },
    async (req) => {
      if (config.DEMO_MODE) return { campaigns: [] };
      const { tenantId } = req.query ?? {};
      const rows = await db
        .select()
        .from(tables.qualityUpdateCampaigns)
        .where(tenantId ? eq(tables.qualityUpdateCampaigns.tenantId, tenantId) : undefined)
        .orderBy(desc(tables.qualityUpdateCampaigns.createdAt));
      return { campaigns: rows };
    },
  );

  /**
   * Release picker for the standalone "Create → Expedite policy" flow —
   * same filtering as `GET /api/missing-kbs/:id/quality-update-releases`
   * (newest B/OOB item per cadence), minus the `matchesKbId` field since
   * there is no specific KB driving this picker.
   */
  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/quality-updates/catalog",
    { preHandler: requirePermission("operations:read") },
    async (req, reply) => {
      const { tenantId } = req.query ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      if (config.DEMO_MODE) return { releases: [] };

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      let items;
      try {
        items = await listQualityUpdateCatalogItems({ engineer, homeTenantId, tenantId });
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(status).send({ error: message });
      }

      const latestByCadence = new Map<"B" | "OOB", { item: (typeof items)[number]; date: Date | null }>();
      for (const item of items) {
        if (item.isExpeditable === false) continue;
        const cadence = parseReleaseCadence(item);
        if (cadence !== "B" && cadence !== "OOB") continue;
        const date = parseReleaseDate(item);
        const current = latestByCadence.get(cadence);
        if (!current || (date && (!current.date || date > current.date))) {
          latestByCadence.set(cadence, { item, date });
        }
      }

      const releases = [...latestByCadence.values()].map(({ item }) => ({
        id: item.id,
        displayName: item.displayName ?? item.id,
        isExpeditable: item.isExpeditable !== false,
        cadence: parseReleaseCadence(item),
      }));
      return { releases };
    },
  );

  /**
   * Standalone Expedited Quality Update creation — release + group, no KB
   * required first. Mirrors `POST /api/feature-updates/campaigns`'s shape:
   * tenant existence/read-only checked directly, no `preflight()` (a group
   * campaign isn't a per-device dispatch).
   */
  app.post<{ Body: CreateExpediteBody }>(
    "/api/quality-updates/campaigns",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Quality update campaigns are unavailable in demo mode" });
      }
      const {
        tenantId,
        displayName,
        catalogItemId,
        releaseLabel,
        daysUntilForcedReboot,
        groupId,
        groupName,
        excludeGroupId,
        excludeGroupName,
      } = req.body ?? {};

      if (
        !tenantId ||
        !displayName?.trim() ||
        !catalogItemId?.trim() ||
        !releaseLabel?.trim() ||
        !groupId?.trim() ||
        !groupName?.trim() ||
        daysUntilForcedReboot === undefined
      ) {
        return reply.code(400).send({
          error:
            "tenantId, displayName, catalogItemId, releaseLabel, daysUntilForcedReboot, groupId and groupName are required",
        });
      }
      if (![0, 1, 2].includes(daysUntilForcedReboot)) {
        return reply.code(400).send({ error: "daysUntilForcedReboot must be 0, 1 or 2" });
      }

      const [tenant] = await db.select().from(tables.tenants).where(eq(tables.tenants.tenantId, tenantId)).limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before creating a policy." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      let targets;
      try {
        targets = await resolveAssignmentTargets({
          mode: "group",
          groupId: groupId.trim(),
          excludeGroupId: excludeGroupId?.trim() || undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }

      let profileId: string;
      try {
        profileId = await createAndAssignQualityUpdateProfile({
          engineer,
          homeTenantId,
          tenantId,
          catalogItemId: catalogItemId.trim(),
          // No Defender KB drives this flow — only used for the profile's
          // auto-generated display name fallback, which is never reached
          // since displayName is required above.
          kbId: "",
          displayName: displayName.trim(),
          daysUntilForcedReboot: daysUntilForcedReboot as 0 | 1 | 2,
          targets,
        });
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(status).send({ error: message });
      }

      const assignments: IntuneAssignmentSummary[] = [
        { kind: "include", groupId: groupId.trim(), groupName: groupName.trim() },
      ];
      if (excludeGroupId?.trim()) {
        assignments.push({
          kind: "exclude",
          groupId: excludeGroupId.trim(),
          groupName: excludeGroupName?.trim() || undefined,
        });
      }

      const [campaign] = await db
        .insert(tables.qualityUpdateCampaigns)
        .values({
          tenantId,
          policyType: "expedite",
          source: "patchpilot",
          displayName: displayName.trim(),
          releaseLabel: releaseLabel.trim(),
          daysUntilForcedReboot,
          assignments,
          intuneProfileId: profileId,
          createdBy: engineer,
        })
        .returning();

      await audit({
        engineer,
        tenantId,
        endpoint: CHANNEL_SPECS["expedited-quality-update"].endpointTemplate,
        method: "POST",
        action: "quality-update-campaign:create",
        resourceType: "quality-update-campaign",
        resourceId: campaign!.id,
        resourceLabel: `${displayName} (${releaseLabel} → ${groupName})`,
        summary: `Created expedite policy "${displayName}" targeting ${releaseLabel} for group "${groupName}"`,
        outcome: "success",
        responseStatus: 201,
      });

      return reply.code(201).send({ campaign });
    },
  );

  /**
   * Deletes an "expedite" policy outright — the Intune `windowsQualityUpdateProfile`
   * itself, not just the local row. Rejects any `"quality-update"` row with
   * 400: that policyType has no PatchPilot write path (see quality-updates.ts
   * in packages/graph).
   */
  app.delete<{ Params: { id: string } }>(
    "/api/quality-updates/campaigns/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Quality update campaigns are unavailable in demo mode" });
      }
      const { id } = req.params;

      const [campaign] = await db
        .select()
        .from(tables.qualityUpdateCampaigns)
        .where(eq(tables.qualityUpdateCampaigns.id, id))
        .limit(1);
      if (!campaign) return reply.code(404).send({ error: "policy not found" });
      if (campaign.policyType !== "expedite") {
        return reply.code(400).send({ error: "only expedite policies can be deleted through PatchPilot" });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, campaign.tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before deleting a policy." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const startedAt = Date.now();

      try {
        await deleteQualityUpdateProfile({
          engineer,
          homeTenantId,
          tenantId: campaign.tenantId,
          intuneProfileId: campaign.intuneProfileId,
        });
        await db.delete(tables.qualityUpdateCampaigns).where(eq(tables.qualityUpdateCampaigns.id, id));
        await audit({
          engineer,
          tenantId: campaign.tenantId,
          endpoint: "/api/quality-updates/campaigns/:id",
          method: "DELETE",
          action: "quality-update-campaign:delete",
          resourceType: "quality-update-campaign",
          resourceId: campaign.id,
          resourceLabel: campaign.displayName,
          summary: `Deleted expedite policy "${campaign.displayName}"`,
          outcome: "success",
          responseStatus: 200,
          latencyMs: Date.now() - startedAt,
        });
        return { deleted: true };
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        await audit({
          engineer,
          tenantId: campaign.tenantId,
          endpoint: "/api/quality-updates/campaigns/:id",
          method: "DELETE",
          action: "quality-update-campaign:delete",
          resourceType: "quality-update-campaign",
          resourceId: campaign.id,
          resourceLabel: campaign.displayName,
          summary: `Failed to delete expedite policy "${campaign.displayName}"`,
          outcome: "failure",
          detail: message,
          responseStatus: status,
          latencyMs: Date.now() - startedAt,
        });
        return reply.code(status).send({ error: message });
      }
    },
  );

  /**
   * Bulk delete — same 3-way shape as feature-updates.ts's bulk-delete route.
   * Any selected `"quality-update"` policyType row is reported back under
   * `skipped` rather than attempted, matching the single-delete route's 400
   * rejection without failing the whole batch over one non-expedite pick.
   */
  app.post<{ Body: { tenantId?: string; ids?: string[] } }>(
    "/api/quality-updates/campaigns/bulk-delete",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Quality update campaigns are unavailable in demo mode" });
      }
      const { tenantId, ids } = req.body ?? {};
      if (!tenantId?.trim()) return reply.code(400).send({ error: "tenantId is required" });
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId.trim()))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before deleting policies." });
      }

      const rows = await db
        .select()
        .from(tables.qualityUpdateCampaigns)
        .where(
          and(
            inArray(tables.qualityUpdateCampaigns.id, ids),
            eq(tables.qualityUpdateCampaigns.tenantId, tenant.tenantId),
          ),
        );
      const foundIds = new Set(rows.map((r) => r.id));
      const notFound = ids.filter((id) => !foundIds.has(id));
      const skipped = rows.filter((r) => r.policyType !== "expedite");
      const eligible = rows.filter((r) => r.policyType === "expedite");

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const deleted: string[] = [];
      const deletedLabels: string[] = [];
      const failed: { id: string; label: string; reason: string }[] = [];

      for (const campaign of eligible) {
        try {
          await deleteQualityUpdateProfile({
            engineer,
            homeTenantId,
            tenantId: campaign.tenantId,
            intuneProfileId: campaign.intuneProfileId,
          });
          await db.delete(tables.qualityUpdateCampaigns).where(eq(tables.qualityUpdateCampaigns.id, campaign.id));
          deleted.push(campaign.id);
          deletedLabels.push(campaign.displayName);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ id: campaign.id, label: campaign.displayName, reason: message });
        }
      }

      await audit({
        engineer,
        tenantId: tenant.tenantId,
        endpoint: "/api/quality-updates/campaigns/bulk-delete",
        method: "POST",
        action: "quality-update-campaign:bulk-delete",
        resourceType: "quality-update-campaign",
        summary: `Deleted ${deleted.length} of ${ids.length} quality update policies`,
        detail: [
          deletedLabels.length ? `Deleted: ${idList(deletedLabels)}` : null,
          notFound.length ? `Not found: ${idList(notFound)}` : null,
          skipped.length ? `Skipped (read-only policyType): ${idList(skipped.map((s) => s.displayName))}` : null,
          failed.length ? `Failed: ${idList(failed.map((f) => f.label))}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        outcome: notFound.length || failed.length || skipped.length ? "partial" : "success",
        responseStatus: 200,
      });

      return {
        deleted,
        notFound,
        failed,
        skipped: skipped.map((s) => s.id),
      };
    },
  );
}
