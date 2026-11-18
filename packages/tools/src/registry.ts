import type { Trust } from '@assistant/core';
import type { AssistantTool, RegisteredTool, ToolFlags } from './types.js';

/**
 * Trust-scoped tool registry. Any externally triggered task loses private
 * owner reads and persistent writes; unknown senders also lose outward-facing
 * tools entirely. This is architectural, not prompt-level.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: AssistantTool, flags: ToolFlags = {}): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { tool, flags });
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * The tool set exposed to the model for a task with the given trust.
   *
   * Externally triggered tasks (known/unknown) lose `acceptsUntrustedInput:
   * false` tools outright — for them it is a forbidden-by-construction boundary.
   *
   * A privileged owner/assistant task whose context has been tainted keeps them.
   * Removing a capability the owner is standing right there asking for does not
   * make the action safer; it makes it invisible. The model cannot see why the
   * tool vanished, so it invents a reason, refuses, and offers the owner a
   * copy-paste workaround — while the dispatcher's `taintNeedsApproval` gate
   * would have produced an approval card showing the exact arguments. Taint
   * therefore constrains *how* these tools run (approval, never autonomous),
   * not *whether* the model can see them.
   */
  toolsForTask(trust: Trust): AssistantTool[] {
    const untrusted = trust === 'unknown';
    const external = untrusted || trust === 'known';
    return [...this.tools.values()]
      .filter(
        ({ tool, flags }) =>
          // A task triggered by an unknown sender gets no attacker-observable
          // network requests at all: neither outward-facing sends nor nominal
          // reads with egress (web.fetch, web.search). Without the egress
          // strip, any DKIM-valid stranger's email could drive blind HTTP
          // requests and paid searches from the owner's IP.
          (!flags.ownerOnly || trust === 'owner') &&
          (!untrusted || (!flags.outwardFacing && !flags.networkEgress)) &&
          (!external || tool.acceptsUntrustedInput) &&
          (!external ||
            (!flags.writesMemory &&
              !flags.confidentialRead &&
              !flags.writesWorkspace &&
              !flags.privateWrite)),
      )
      .map(({ tool }) => tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  resultIsUntrusted(name: string): boolean {
    return this.tools.get(name)?.flags.returnsUntrustedContent === true;
  }

  /**
   * Whether an approval for this tool may be resolved by a one-tap SMS reply
   * ("YES A7"). SMS sender identity is a spoofable From number, so only
   * low-consequence tools qualify: nothing that reaches a third party
   * (outwardFacing), egresses to the network (networkEgress), or writes durable
   * memory (writesMemory) — and only when the tool defines a payload-bearing
   * approvalSummary, so the 160-char SMS actually shows what is being approved
   * rather than a generic fallback. Everything else must be reviewed on the
   * authenticated dashboard, where the exact arguments are visible.
   */
  smsApprovable(toolName: string): boolean {
    const registered = this.tools.get(toolName);
    if (!registered) return false;
    const { tool, flags } = registered;
    // Reject EVERY privileged capability, mirroring toolsForTask's external
    // strip set exactly — a tool carrying only an omitted flag (privateWrite,
    // writesWorkspace, confidentialRead) would otherwise fail open to one-tap
    // SMS approval despite arming a real private side effect (e.g.
    // applications.watch_confirmation). blanketAllowIneligible tools are always
    // consequential enough to demand the dashboard too.
    if (
      flags.outwardFacing ||
      flags.networkEgress ||
      flags.writesMemory ||
      flags.writesWorkspace ||
      flags.privateWrite ||
      flags.confidentialRead ||
      flags.blanketAllowIneligible
    ) {
      return false;
    }
    return typeof tool.approvalSummary === 'function';
  }
}
