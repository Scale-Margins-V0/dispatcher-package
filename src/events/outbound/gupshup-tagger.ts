import type { SendContext } from "../../providers/types.js";

/** No-op until Gupshup outbound send is implemented. */
export function applyGupshupTag<T>(message: T, _ctx: SendContext): T {
  return message;
}
