/**
 * Public entry: `lookupUsers` + test helpers. Implementation lives under `src/user-lookup/`.
 */

export {
  lookupUsers,
  type UserRecord,
  resetLookupAdapterForTests,
  reloadLookupAdapter,
} from "./user-lookup/index.js";
export { resetDispatchConfigForTests } from "./user-lookup/config.js";
