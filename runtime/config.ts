/**
 * Runtime configuration, read from the injected <script> tag's data-*
 * attributes (written by the injector), e.g.
 *   <script src="plexweb-mods.js?v=..." data-chunk-globals="webpackChunkfoo"
 *           data-report-delay-ms="8000" data-banner="on" data-opt-pfh-companion="off">
 */
import type { RuntimeConfig } from "./types";

export const DEFAULT_CONFIG: RuntimeConfig = {
  chunkGlobals: ["webpackJsonp"],
  reportDelayMs: 8000,
  banner: true,
  debug: false,
  options: {},
};

const truthy = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : !/^(0|off|false|no)$/i.test(v.trim()));

export function parseConfig(dataset: Record<string, string | undefined>, debugOverride?: string | null): RuntimeConfig {
  const names = (dataset.chunkGlobals ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
  const delay = Number(dataset.reportDelayMs);
  const options: Record<string, string> = {};
  for (const [k, v] of Object.entries(dataset)) {
    if (k.startsWith("opt") && k.length > 3 && v !== undefined) {
      // dataset camel-cases data-opt-pfh-companion as optPfhCompanion
      const key = k.slice(3).replace(/[A-Z]/g, (c, i: number) => (i === 0 ? c.toLowerCase() : `-${c.toLowerCase()}`));
      options[key] = v;
    }
  }
  return {
    chunkGlobals: [...new Set([...DEFAULT_CONFIG.chunkGlobals, ...names])],
    reportDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_CONFIG.reportDelayMs,
    banner: truthy(dataset.banner, DEFAULT_CONFIG.banner),
    debug: truthy(debugOverride ?? dataset.debug, DEFAULT_CONFIG.debug),
    options,
  };
}
