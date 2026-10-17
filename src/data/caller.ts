/**
 * Which app is calling a data_* op (C230 R3, Coordinator ruling): the identity MUST come from the VERIFIED caller
 * product, never from the app's manifest name (a name is not an identity: any installed app can carry any name).
 *
 * The SDK does not give a handler the verified product yet (request SDK-CALLER-PRODUCT, expected in miniapp-sdk
 * 0.1.27). Until it does, `verifiedAppProduct` answers null and all three data ops refuse EVERY caller with
 * `data_ops_unavailable` (503): fail closed. The owner can still set shares; they take effect when Connect is updated.
 * When the SDK offers the product, change `verifiedAppProduct` to read it and flip DATA_OPS_VERIFIED_PRODUCT_SUPPORTED.
 */
import type { OpContext } from "@opt2-tealbrick/spec/sdk";

/** true once `verifiedAppProduct` can answer from the SDK's verified caller product. */
export const DATA_OPS_VERIFIED_PRODUCT_SUPPORTED = false;
export const DATA_OPS_UNAVAILABLE_CODE = "data_ops_unavailable";
export const DATA_OPS_UNAVAILABLE_MESSAGE = "Connect data sharing needs a newer Tealbrick SDK";

/** The product id of the calling app as the SDK verified it, or null (not an app, or not verifiable). Today: always null. */
export function verifiedAppProduct(_ctx: OpContext): string | null {
  return null;
}
