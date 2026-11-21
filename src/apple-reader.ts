import { App, FileSystemAdapter, normalizePath } from "obsidian";
import { execFile } from "node:child_process";
import type { AppleEvent, AppleReminder } from "./apple-model";

export type Kind = "calendar" | "reminders";
type State = "ok" | "notDetermined" | "denied" | "restricted" | "unsupported" | "failed" | "missing" | "timeout";
type Data = Partial<{ events: AppleEvent[]; reminders: AppleReminder[] }>;
export type Snapshot = Data & { state: State; lastSuccess?: number };
const ACCESS_FAILURES = new Set<State>(["denied", "restricted", "notDetermined"]);

export class AppleReader {
  private readonly cache = new Map<Kind, Snapshot>();
  private readonly pending = new Map<Kind, Promise<Snapshot>>();

  constructor(private readonly app: App, private readonly pluginDir: string) {}

  last(kind: Kind): Snapshot | undefined { return this.cache.get(kind); }

  refresh(kind: Kind, authorize = false): Promise<Snapshot> {
    const existing = this.pending.get(kind);
    if (existing) return authorize ? existing.then(() => this.refresh(kind, true)) : existing;
    const request = this.run(kind, authorize).then(result => {
      const previous = this.cache.get(kind);
      const snapshot = result.state === "ok" ? { ...result, lastSuccess: Date.now() }
        : { ...(ACCESS_FAILURES.has(result.state) ? {} : previous), ...result, lastSuccess: previous?.lastSuccess };
      this.cache.set(kind, snapshot);
      return snapshot;
    }).finally(() => this.pending.delete(kind));
    this.pending.set(kind, request);
    return request;
  }

  openApp(kind: Kind): void {
    if (process.platform !== "darwin") return;
    execFile("/usr/bin/open", ["-a", kind === "calendar" ? "Calendar" : "Reminders"], () => undefined);
  }

  private async run(kind: Kind, authorize: boolean): Promise<Snapshot> {
    const adapter = this.app.vault.adapter;
    if (process.platform !== "darwin" || !(adapter instanceof FileSystemAdapter)) return { state: "unsupported" };
    const path = normalizePath(this.pluginDir + "/apple-helper/apple-reader");
    if (!await adapter.exists(path).catch(() => false)) return { state: "missing" };
    return new Promise(resolve => {
      execFile(adapter.getFullPath(path), [authorize ? "authorize" : "read", kind], {
        timeout: authorize ? 120_000 : 15_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8"
      }, (error, stdout) => {
        if (error) { resolve({ state: error.killed ? "timeout" : "failed" }); return; }
        try {
          const response = JSON.parse(stdout) as Data & { status: State };
          const state = response.status;
          if (state === "ok" && kind === "calendar" && Array.isArray(response.events)) {
            resolve({ state, events: response.events });
          } else if (state === "ok" && kind === "reminders" && Array.isArray(response.reminders)) {
            resolve({ state, reminders: response.reminders });
          } else if (["notDetermined", "denied", "restricted", "unsupported"].includes(state)) {
            resolve({ state });
          } else resolve({ state: "failed" });
        } catch { resolve({ state: "failed" }); }
      });
    });
  }
}
