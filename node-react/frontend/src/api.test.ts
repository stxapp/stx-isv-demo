import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";

describe("what the person is told when a call fails", () => {
  test("the app's own sentence is shown, not its error code", () => {
    const body = { error: "account_pending", message: "STX is still verifying your account. Finish verifying your STX account, then try again." };
    expect(ApiError.describe(409, body)).toBe(body.message);
  });

  test("STX's rejection reason is shown as it is", () => {
    expect(ApiError.describe(422, { error: "Invalid order fields: price - can't be blank" })).toBe(
      "Invalid order fields: price - can't be blank",
    );
  });

  test("a missing link reads as not connected", () => {
    expect(ApiError.describe(401, { error: "not_linked", message: "anything" })).toBe("Your STX account isn’t connected.");
  });

  test("a refused sign-in is not reported as a missing STX link", () => {
    const body = { error: "invalid_privy_token", message: "Your sign-in could not be verified. Sign in again." };
    expect(ApiError.describe(401, body)).toBe(body.message);
    expect(ApiError.describe(401, null)).toBe("Your STX account isn’t connected.");
  });

  test("with nothing to go on, the status", () => {
    expect(ApiError.describe(500, null)).toBe("API error 500");
  });
});
