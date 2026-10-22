import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { adminAuth } from "./adminAuth";

function mockReq(headerValue?: string | string[]): Partial<Request> {
  return {
    header: vi.fn((name: string) => (name === "X-Admin-Key" ? headerValue : undefined)),
    requestId: "req-test",
    correlationId: "corr-test",
  } as unknown as Partial<Request>;
}

function mockRes(): { res: Partial<Response>; status: any; json: any } {
  const status = vi.fn();
  const json = vi.fn();
  const res = { status, json } as unknown as Partial<Response>;
  (status as any).mockReturnValue(res);
  return { res, status, json };
}

describe("adminAuth middleware (#1109)", () => {
  const original = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "a".repeat(32);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  });

  it("passes through on a matching key", () => {
    const req = mockReq("a".repeat(32));
    const { res } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("401 ADMIN_KEY_MISSING when header absent", () => {
    const req = mockReq(undefined);
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_MISSING", statusCode: 401 }),
    );
  });

  it("401 ADMIN_KEY_MALFORMED when header is empty", () => {
    const req = mockReq("");
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_MALFORMED" }),
    );
  });

  it("401 ADMIN_KEY_MALFORMED when header is whitespace only", () => {
    const req = mockReq("   ");
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_MALFORMED" }),
    );
  });

  it("401 ADMIN_KEY_MALFORMED when header is repeated (array)", () => {
    const req = mockReq(["a".repeat(32), "b".repeat(32)]);
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_MALFORMED" }),
    );
  });

  it("401 ADMIN_KEY_INVALID when key does not match", () => {
    const req = mockReq("b".repeat(32));
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_INVALID" }),
    );
  });

  it("401 ADMIN_KEY_NOT_CONFIGURED when env is unset", () => {
    delete process.env.ADMIN_API_KEY;
    const req = mockReq("a".repeat(32));
    const { res, status, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ADMIN_KEY_NOT_CONFIGURED" }),
    );
  });

  it("response body includes requestId and correlationId from req", () => {
    const req = mockReq(undefined);
    const { res, json } = mockRes();
    const next = vi.fn();
    adminAuth(req as Request, res as Response, next as NextFunction);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-test",
        correlationId: "corr-test",
      }),
    );
  });
});
