import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { CHANNEL_SPECS, CLIENT_BUILDS, resolveTargetBuild } from "@patchpilot/shared";
import {
  audit,
  GraphError,
  createAndAssignCampaignFeatureUpdateProfile,
  deleteFeatureUpdateProfile,
} from "@patchpilot/graph";
import type { FeatureUpdateAssignmentSummary } from "@patchpilot/db";
import { config } from "../config.js";
import { resolveAssignmentTargets } from "../services/win32-app-deploy.js";
import { requirePermission } from "../auth/rbac.js";
import { syncFeatureUpdateProfiles } from "../graph/sync.js";

/**
 * Windows feature-update campaign routes.
 *
 * There is no single-device "Update to <version>" dispatch here — Intune's
 * `windowsFeatureUpdateProfiles/{id}/assign` has no per-device assignment
 * target (confirmed live: `allDevicesAssignmentTarget` and the base
 * `deviceAndAppManagementAssignmentTarget` narrowed by an assignment filter
 * are both rejected). A group is the only assignable target, matching what
 * the Intune admin center itself offers, so `/campaigns` — a group-targeted,
 * scheduled rollout — is the only way to push a feature update through
 * PatchPilot. It is NOT a job dispatch: Intune paces the rollout itself via
 * `rolloutSettings`, so this is a direct synchronous Graph write, recorded in
 * `feature_update_campaigns` purely as a creation-time snapshot for the list
 * UI.
 */

function idList(items: readonly string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} + ${items.length - max} more`;
}

interface FeatureUpdateCampaignBody {
  tenantId?: string;
  displayName?: string;
  targetVersionLabel?: string;
  groupId?: string;
  groupName?: string;
  excludeGroupId?: string;
  excludeGroupName?: string;
  offerStartDateTimeInUTC?: string;
  offerEndDateTimeInUTC?: string;
  offerIntervalInDays?: number;
  installFeatureUpdatesOptional?: boolean;
}

export async function featureUpdatesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  /**
   * Group campaign list — a creation-time snapshot, not a live Graph read
   * (see schema.ts's doc comment on `feature_update_campaigns`).
   */
  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/feature-updates/campaigns",
    { preHandler: requirePermission("operations:read") },
    async (req) => {
      if (config.DEMO_MODE) return { campaigns: [] };
      const { tenantId } = req.query ?? {};
      const rows = await db
        .select()
        .from(tables.featureUpdateCampaigns)
        .where(tenantId ? eq(tables.featureUpdateCampaigns.tenantId, tenantId) : undefined)
        .orderBy(desc(tables.featureUpdateCampaigns.createdAt));
      return { campaigns: rows };
    },
  );

  /**
   * Page-local "Sync now" — a lightweight, single-purpose refresh of just this
   * tenant's windowsFeatureUpdateProfiles, distinct from the heavy full-tenant
   * `/api/sync/:tenantId/data` bundle (devices, vulns, software, etc.). Picks up
   * profiles created directly in the Intune admin center as well as keeping
   * PatchPilot's own campaigns current, and prunes rows for profiles Graph no
   * longer reports.
   */
  app.post<{ Body: { tenantId?: string } }>(
    "/api/feature-updates/campaigns/sync",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Feature update campaign sync is unavailable in demo mode" });
      }
      const { tenantId } = req.body ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });

      const engineer = {
        upn: req.session.engineer!.upn,
        homeTenantId: req.session.engineer!.homeTenantId,
      };
      const startedAt = Date.now();
      try {
        const result = await syncFeatureUpdateProfiles(engineer, tenantId);
        await audit({
          engineer: engineer.upn,
          tenantId,
          endpoint: "/api/feature-updates/campaigns/sync",
          method: "POST",
          action: "feature-update-campaign:sync",
          resourceType: "feature-update-campaign",
          resourceLabel: tenant.displayName,
          summary: `Synced ${result.count} feature update campaign(s) for ${tenant.displayName}`,
          outcome: "success",
          responseStatus: 200,
          latencyMs: Date.now() - startedAt,
        });
        return { count: result.count };
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        await audit({
          engineer: engineer.upn,
          tenantId,
          endpoint: "/api/feature-updates/campaigns/sync",
          method: "POST",
          action: "feature-update-campaign:sync",
          resourceType: "feature-update-campaign",
          resourceLabel: tenant.displayName,
          summary: `Sync of feature update campaigns for ${tenant.displayName} failed`,
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
   * Group campaign creation — a direct synchronous Graph write, not a job
   * dispatch (Intune paces the rollout itself via `rolloutSettings`; there is
   * no worker involvement). Mirrors `POST /api/intune-apps/win32`'s shape:
   * tenant existence/read-only checked directly, no `preflight()` — that
   * function models a per-device dispatch, and this isn't one.
   */
  app.post<{ Body: FeatureUpdateCampaignBody }>(
    "/api/feature-updates/campaigns",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Feature update campaigns are unavailable in demo mode" });
      }
      const {
        tenantId,
        displayName,
        targetVersionLabel,
        groupId,
        groupName,
        excludeGroupId,
        excludeGroupName,
        offerStartDateTimeInUTC,
        offerEndDateTimeInUTC,
        offerIntervalInDays,
        installFeatureUpdatesOptional,
      } = req.body ?? {};

      if (
        !tenantId ||
        !displayName?.trim() ||
        !targetVersionLabel?.trim() ||
        !groupId?.trim() ||
        !groupName?.trim() ||
        !offerStartDateTimeInUTC ||
        !offerEndDateTimeInUTC ||
        !offerIntervalInDays
      ) {
        return reply.code(400).send({
          error:
            "tenantId, displayName, targetVersionLabel, groupId, groupName, offerStartDateTimeInUTC, " +
            "offerEndDateTimeInUTC and offerIntervalInDays are required",
        });
      }
      if (!Object.values(CLIENT_BUILDS).includes(targetVersionLabel)) {
        return reply.code(400).send({ error: `unknown target version: ${targetVersionLabel}` });
      }
      const start = new Date(offerStartDateTimeInUTC);
      const end = new Date(offerEndDateTimeInUTC);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return reply.code(400).send({ error: "offerStartDateTimeInUTC/offerEndDateTimeInUTC must be valid dates" });
      }
      if (!Number.isInteger(offerIntervalInDays) || offerIntervalInDays < 1) {
        return reply.code(400).send({ error: "offerIntervalInDays must be a positive integer" });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before creating a campaign." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const targetBuild = resolveTargetBuild(targetVersionLabel);

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
        profileId = await createAndAssignCampaignFeatureUpdateProfile({
          engineer,
          homeTenantId,
          tenantId,
          displayName: displayName.trim(),
          targetBuild,
          targets,
          offerStartDateTimeInUTC: start.toISOString(),
          offerEndDateTimeInUTC: end.toISOString(),
          offerIntervalInDays,
          installFeatureUpdatesOptional: Boolean(installFeatureUpdatesOptional),
        });
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(status).send({ error: message });
      }

      const assignments: FeatureUpdateAssignmentSummary[] = [
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
        .insert(tables.featureUpdateCampaigns)
        .values({
          tenantId,
          displayName: displayName.trim(),
          targetVersion: targetVersionLabel,
          targetBuild,
          assignments,
          source: "patchpilot",
          intuneProfileId: profileId,
          offerStartDateTimeInUTC: start,
          offerEndDateTimeInUTC: end,
          offerIntervalInDays,
          installFeatureUpdatesOptional: Boolean(installFeatureUpdatesOptional),
          createdBy: engineer,
        })
        .returning();

      await audit({
        engineer,
        tenantId,
        endpoint: CHANNEL_SPECS["expedited-feature-update"].endpointTemplate,
        method: "POST",
        action: "feature-update-campaign:create",
        resourceType: "feature-update-campaign",
        resourceId: campaign!.id,
        resourceLabel: `${displayName} (${targetVersionLabel} → ${groupName})`,
        summary: `Created feature update campaign "${displayName}" targeting ${targetVersionLabel} for group "${groupName}"`,
        outcome: "success",
        responseStatus: 201,
      });

      return reply.code(201).send({ campaign });
    },
  );

  /**
   * Deletes the campaign outright — removes the `windowsFeatureUpdateProfile`
   * from Intune itself (not just PatchPilot's list), whether PatchPilot
   * created it or it was synced in from the Intune admin center. Only the
   * local row is a `sync`-refreshed cache; the profile in Graph is the real
   * object, so a local-only delete would just have it reappear on the next
   * sync pass.
   */
  app.delete<{ Params: { id: string } }>(
    "/api/feature-updates/campaigns/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Feature update campaigns are unavailable in demo mode" });
      }
      const { id } = req.params;

      const [campaign] = await db
        .select()
        .from(tables.featureUpdateCampaigns)
        .where(eq(tables.featureUpdateCampaigns.id, id))
        .limit(1);
      if (!campaign) return reply.code(404).send({ error: "campaign not found" });

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, campaign.tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before deleting a campaign." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const resourceLabel = `${campaign.displayName} (${campaign.targetVersion})`;
      const startedAt = Date.now();

      try {
        await deleteFeatureUpdateProfile({
          engineer,
          homeTenantId,
          tenantId: campaign.tenantId,
          intuneProfileId: campaign.intuneProfileId,
        });
        await db.delete(tables.featureUpdateCampaigns).where(eq(tables.featureUpdateCampaigns.id, id));
        await audit({
          engineer,
          tenantId: campaign.tenantId,
          endpoint: "/api/feature-updates/campaigns/:id",
          method: "DELETE",
          action: "feature-update-campaign:delete",
          resourceType: "feature-update-campaign",
          resourceId: campaign.id,
          resourceLabel,
          summary: `Deleted feature update campaign "${campaign.displayName}"`,
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
          endpoint: "/api/feature-updates/campaigns/:id",
          method: "DELETE",
          action: "feature-update-campaign:delete",
          resourceType: "feature-update-campaign",
          resourceId: campaign.id,
          resourceLabel,
          summary: `Failed to delete feature update campaign "${campaign.displayName}"`,
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
   * Bulk delete for the Windows Updates hub's Feature Updates tab multi-select
   * toolbar. Unlike script-catalog's bulk-delete (a pure local-row delete),
   * each id here is a real Intune profile — mirrors the single-delete route's
   * Graph-then-local-row order per id, so a Graph failure never silently
   * leaves a stale local row hidden from the next sync's prune. One audit row
   * for the whole batch, not one per campaign — matches script-catalog's
   * bulk-delete convention.
   */
  app.post<{ Body: { tenantId?: string; ids?: string[] } }>(
    "/api/feature-updates/campaigns/bulk-delete",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Feature update campaigns are unavailable in demo mode" });
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
          .send({ error: "Tenant is read-only — opt in to write actions before deleting campaigns." });
      }

      const rows = await db
        .select()
        .from(tables.featureUpdateCampaigns)
        .where(
          and(
            inArray(tables.featureUpdateCampaigns.id, ids),
            eq(tables.featureUpdateCampaigns.tenantId, tenant.tenantId),
          ),
        );
      const foundIds = new Set(rows.map((r) => r.id));
      const notFound = ids.filter((id) => !foundIds.has(id));

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const deleted: string[] = [];
      const deletedLabels: string[] = [];
      const failed: { id: string; label: string; reason: string }[] = [];

      for (const campaign of rows) {
        try {
          await deleteFeatureUpdateProfile({
            engineer,
            homeTenantId,
            tenantId: campaign.tenantId,
            intuneProfileId: campaign.intuneProfileId,
          });
          await db.delete(tables.featureUpdateCampaigns).where(eq(tables.featureUpdateCampaigns.id, campaign.id));
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
        endpoint: "/api/feature-updates/campaigns/bulk-delete",
        method: "POST",
        action: "feature-update-campaign:bulk-delete",
        resourceType: "feature-update-campaign",
        summary: `Deleted ${deleted.length} of ${ids.length} feature update campaigns`,
        detail: [
          deletedLabels.length ? `Deleted: ${idList(deletedLabels)}` : null,
          notFound.length ? `Not found: ${idList(notFound)}` : null,
          failed.length ? `Failed: ${idList(failed.map((f) => f.label))}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        outcome: notFound.length || failed.length ? "partial" : "success",
        responseStatus: 200,
      });

      return { deleted, notFound, failed };
    },
  );
}
