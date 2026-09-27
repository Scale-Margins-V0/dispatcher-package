/**
 * Call metadata CRUD — schemas of keys an api variable can attach. Definitions
 * in, definitions out; never a value.
 *
 * Deleting a schema, or removing a key, that an api variable still uses is
 * refused with 409 and the variables named — a request must never silently
 * start sending an empty value.
 */

import type { Request, Response } from "express";
import {
  createCallMetadata,
  deleteCallMetadata,
  getCallMetadata,
  listCallMetadata,
  updateCallMetadata,
} from "../../../db/repos/call-metadata.js";
import { componentLogger } from "../../../logging/logger.js";
import { LogComponent } from "../../../logging/conventions.js";
import {
  metadataUsage,
  serializeCallMetadata,
  ZCreateCallMetadataSchema,
  ZUpdateCallMetadataSchema,
} from "../../../variables/call-metadata.js";
import { apiError, invalidRequest } from "../errors.js";
import { ZVariableNameParamSchema } from "../validators/dataplane.validator.js";
import { actor, logRejected, requireStateDb } from "./dataplane.controller.js";

const log = componentLogger(LogComponent.apiDataplane);

/** GET /call-metadata — every schema, with the variables using it. Tens per dispatcher; not paged. */
export async function listCallMetadataHandler(_req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;
  const [rows, usage] = await Promise.all([listCallMetadata(), metadataUsage()]);
  res.json({
    generated_at: new Date().toISOString(),
    call_metadata: rows.map((row) => serializeCallMetadata(row, usage.get(row.id))),
  });
}

/** GET /call-metadata/:name */
export async function getCallMetadataHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;
  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);
  const row = await getCallMetadata(params.data.name);
  if (!row) {
    apiError(res, "not_found", `Call metadata "${params.data.name}" does not exist`);
    return;
  }
  res.json({ call_metadata: serializeCallMetadata(row, (await metadataUsage()).get(row.id)) });
}

/** POST /call-metadata */
export async function createCallMetadataHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;
  const parsed = ZCreateCallMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    logRejected("call_metadata.create", parsed.error);
    return invalidRequest(res, parsed.error);
  }
  const { name, keys } = parsed.data;
  if (await getCallMetadata(name)) {
    apiError(res, "conflict", `Call metadata "${name}" already exists`);
    return;
  }
  const row = await createCallMetadata({ name, keys, updated_by: actor(req) });
  log.info({ call_metadata: name, keys: keys.length }, "Call metadata created");
  res.status(201).json({ call_metadata: serializeCallMetadata(row) });
}

/**
 * PATCH /call-metadata/:name — rename and/or replace the key list whole.
 * Renaming is always safe (variables hold the id); dropping a key a variable's
 * request uses is not.
 */
export async function updateCallMetadataHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;
  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);
  const parsed = ZUpdateCallMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    logRejected("call_metadata.update", parsed.error);
    return invalidRequest(res, parsed.error);
  }

  const current = params.data.name;
  const existing = await getCallMetadata(current);
  if (!existing) {
    apiError(res, "not_found", `Call metadata "${current}" does not exist`);
    return;
  }
  const { name, keys } = parsed.data;
  if (name !== undefined && name !== current && (await getCallMetadata(name))) {
    apiError(res, "conflict", `Call metadata "${name}" already exists`);
    return;
  }

  const usage = (await metadataUsage()).get(existing.id) ?? [];
  if (keys !== undefined) {
    const kept = new Set(keys.map((k) => k.key));
    const broken = usage.flatMap((u) =>
      u.keys.filter((k) => !kept.has(k)).map((k) => ({ variable: u.variable, key: k }))
    );
    if (broken.length > 0) {
      log.warn({ call_metadata: current, broken }, "Call metadata update refused — keys still in use");
      apiError(
        res,
        "conflict",
        "Some removed or renamed keys are still used by api variables",
        broken.map((b) => ({
          path: "keys",
          message: `${b.variable} uses {{${b.key}.k}} / {{${b.key}.v}} — remove it from that variable first`,
        }))
      );
      return;
    }
  }

  const row = await updateCallMetadata(current, {
    ...(name !== undefined ? { name } : {}),
    ...(keys !== undefined ? { keys } : {}),
    updated_by: actor(req),
  });
  if (!row) {
    apiError(res, "not_found", `Call metadata "${current}" no longer exists`);
    return;
  }
  log.info({ call_metadata: current, changed: Object.keys(parsed.data) }, "Call metadata updated");
  res.json({ call_metadata: serializeCallMetadata(row, usage) });
}

/** DELETE /call-metadata/:name — refused while any api variable attaches it. */
export async function deleteCallMetadataHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;
  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);
  const existing = await getCallMetadata(params.data.name);
  if (!existing) {
    apiError(res, "not_found", `Call metadata "${params.data.name}" does not exist`);
    return;
  }
  const usedBy = (await metadataUsage()).get(existing.id) ?? [];
  if (usedBy.length > 0) {
    apiError(
      res,
      "conflict",
      `"${existing.name}" is used by ${usedBy.map((u) => u.variable).join(", ")} — detach it from those variables first`
    );
    return;
  }
  await deleteCallMetadata(existing.name);
  log.info({ call_metadata: existing.name }, "Call metadata deleted");
  res.json({ deleted: true, name: existing.name });
}
