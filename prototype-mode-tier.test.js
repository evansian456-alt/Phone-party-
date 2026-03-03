/**
 * @jest-environment node
 */

/**
 * Auth Flow and Prototype Removal Tests
 *
 * These tests verify:
 * - No prototype bypass routes exist
 * - prototypeMode is ignored by the server
 * - /api/me requires authentication (returns 401 when unauthenticated)
 * - /api/complete-profile requires authentication
 * - Paid features remain gated (free tier cannot access paid endpoints)
 */

const request = require("supertest");
const { app, waitForRedis, redis, parties } = require("./server");

describe("Auth Flow & Prototype Removal", () => {
  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (error) {
      console.error("Failed to connect to Redis:", error.message);
    }
  });

  beforeEach(async () => {
    parties.clear();
    if (redis) await redis.flushall();
  });

  describe("No prototype bypass routes", () => {
    it("should return 404 for /prototype route", async () => {
      const res = await request(app).get("/prototype");
      expect(res.status).toBe(404);
    });

    it("should return 404 for /dev-login route", async () => {
      const res = await request(app).get("/dev-login");
      expect(res.status).toBe(404);
    });

    it("should return 404 for /force-tier route", async () => {
      const res = await request(app).get("/force-tier");
      expect(res.status).toBe(404);
    });
  });

  describe("prototypeMode ignored by server", () => {
    it("should create party without setting tier when prototypeMode is sent", async () => {
      const res = await request(app)
        .post("/api/create-party")
        .send({
          djName: "DJ Test",
          source: "local",
          prototypeMode: true,
          tier: "PRO"
        })
        .expect(200);

      expect(res.body).toHaveProperty("partyCode");
      const partyCode = res.body.partyCode;

      // Party state should have null tier (not PRO) since prototypeMode is ignored
      const stateRes = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);

      expect(stateRes.body.tierInfo.tier).toBeNull();
    });

    it("should create party without tier even if PRO tier is requested via prototypeMode", async () => {
      const res = await request(app)
        .post("/api/create-party")
        .send({
          djName: "DJ Pro Attempt",
          source: "local",
          prototypeMode: true,
          tier: "PARTY_PASS"
        })
        .expect(200);

      const partyCode = res.body.partyCode;
      const stateRes = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);

      // Backend should ignore client-supplied tier
      expect(stateRes.body.tierInfo.tier).toBeNull();
      expect(stateRes.body.tierInfo.maxPhones).toBeNull();
    });
  });

  describe("Authentication required endpoints", () => {
    it("GET /api/me should return 401 when not authenticated", async () => {
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(401);
    });

    it("POST /api/complete-profile should return 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/complete-profile")
        .send({});
      expect(res.status).toBe(401);
    });
  });

  describe("Party creation defaults", () => {
    it("should create party with null tier by default (no prototype mode)", async () => {
      const res = await request(app)
        .post("/api/create-party")
        .send({ djName: "DJ Normal", source: "local" })
        .expect(200);

      expect(res.body).toHaveProperty("partyCode");
      const partyCode = res.body.partyCode;

      const stateRes = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);

      expect(stateRes.body.tierInfo.tier).toBeNull();
    });

    it("should still require DJ name for party creation", async () => {
      const res = await request(app)
        .post("/api/create-party")
        .send({ source: "local" })
        .expect(400);

      expect(res.body).toHaveProperty("error");
    });
  });

  describe("Free tier cannot access paid endpoints", () => {
    it("party with no tier should not have paid maxPhones set", async () => {
      const res = await request(app)
        .post("/api/create-party")
        .send({ djName: "DJ Free Test", source: "local" })
        .expect(200);

      const partyCode = res.body.partyCode;
      const stateRes = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);

      expect(stateRes.body.tierInfo.maxPhones).toBeNull();
      expect(stateRes.body.tierInfo.partyPassExpiresAt).toBeNull();
    });
  });
});

