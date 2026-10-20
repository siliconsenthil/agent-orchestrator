import { beforeEach, describe, expect, it, vi } from "vitest";

// initTelemetry memoizes its result in a module-scoped promise, so each test
// resets the module registry and re-mocks the heavy boundaries (posthog, the
// Electron bridge) before importing. This exercises the real init control flow.

const posthogStub = {
	init: vi.fn(),
	register: vi.fn(),
	capture: vi.fn((_event?: string, _properties?: Record<string, unknown>) => ({})),
	captureException: vi.fn(),
	addExceptionStep: vi.fn(),
};

function mockPosthog() {
	vi.doMock("posthog-js/dist/module.full.no-external", () => ({
		default: posthogStub,
		PostHog: class {},
	}));
}

describe("initTelemetry recovery", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("retries init after a transient thrown failure instead of caching it", async () => {
		let calls = 0;
		mockPosthog();
		vi.doMock("./bridge", () => ({
			aoBridge: {
				telemetry: {
					getBootstrap: vi.fn(async () => {
						calls++;
						if (calls === 1) throw new Error("transient bootstrap failure");
						return { appVersion: "1.2.3", platform: "darwin", distinctId: "ins_test", disabledEvents: [], eventsEnabled: true, consentGeneration: "generation-1" };
					}),
				},
				updateSettings: { get: vi.fn(async () => ({})) },
			},
		}));

		const { initTelemetry } = await import("./telemetry");
		// First attempt throws -> caught -> false, and the memoized promise is dropped.
		expect(await initTelemetry()).toBe(false);
		// A later call retries and succeeds, rather than the whole session staying dark.
		expect(await initTelemetry()).toBe(true);
		expect(calls).toBe(2);
	});

	it("keeps a deliberately withheld result memoized (no retry, no re-bootstrap)", async () => {
		// Null bootstrap = telemetry withheld (no key / not opted in). That is a
		// deliberate false, not an error, so it must stay cached and NOT retry.
		const getBootstrap = vi.fn(async () => null);
		mockPosthog();
		vi.doMock("./bridge", () => ({
			aoBridge: {
				telemetry: { getBootstrap },
				updateSettings: { get: vi.fn(async () => ({})) },
			},
		}));

		const { initTelemetry } = await import("./telemetry");
		expect(await initTelemetry()).toBe(false);
		expect(await initTelemetry()).toBe(false);
		// Memoized: the withheld result is not re-attempted.
		expect(getBootstrap).toHaveBeenCalledTimes(1);
	});

	it("initializes PostHog when failure reporting is disabled", async () => {
		mockPosthog();
		vi.doMock("./bridge", () => ({
			aoBridge: {
				telemetry: {
					getBootstrap: vi.fn(async () => ({
						appVersion: "1.2.3", platform: "darwin", distinctId: "ins_test",
						disabledEvents: [], eventsEnabled: false, consentGeneration: "generation-off",
					})),
				},
				updateSettings: { get: vi.fn(async () => ({})) },
			},
		}));

		const { applyRendererTelemetryPolicy, clearRendererTelemetryQueues, initTelemetry } = await import("./telemetry");
		expect(await initTelemetry()).toBe(true);
		expect(posthogStub.init).toHaveBeenCalledOnce();
		expect(() => clearRendererTelemetryQueues()).not.toThrow();
		expect(() => applyRendererTelemetryPolicy(false)).not.toThrow();
	});

	it("deduplicates updater failures at the real capture boundary and rejects obsolete names", async () => {
		localStorage.clear();
		mockPosthog();
		vi.doMock("./bridge", () => ({
			aoBridge: {
				telemetry: { getBootstrap: vi.fn(async () => ({
					appVersion: "1.2.3", platform: "darwin", distinctId: "ins_test",
					disabledEvents: [], eventsEnabled: true, consentGeneration: "generation-1",
				})) },
				updateSettings: { get: vi.fn(async () => ({})) },
			},
		}));
		const { captureRendererEvent, initTelemetry } = await import("./telemetry");
		expect(await initTelemetry()).toBe(true);
		posthogStub.capture.mockClear();
		const failure = { phase: "download", error_category: "network", to_version: "2.0.0" };
		expect(await captureRendererEvent("ao.renderer.update_failed", failure)).toBe(true);
		expect(await captureRendererEvent("ao.renderer.update_failed", failure)).toBe(false);
		expect(await captureRendererEvent("ao.renderer.task_create_requested")).toBe(false);
		expect(await captureRendererEvent("tools.call")).toBe(false);
		expect(await captureRendererEvent("ao.renderer.update_downloaded", failure)).toBe(true);
		expect(await captureRendererEvent("ao.renderer.update_failed", failure)).toBe(true);
		expect(posthogStub.capture.mock.calls.map(([name]) => name)).toEqual([
			"ao.renderer.update_failed", "ao.renderer.update_downloaded", "ao.renderer.update_failed",
		]);
	});
});
