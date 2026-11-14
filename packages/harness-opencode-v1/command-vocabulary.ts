// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandOption } from "@otk/protocol";

/** Native 1.19.3 TUI autocomplete puts local slash registrations first. */
export function nativeCommands(): CommandOption[] {
  const bound = (
    name: string,
    action: string,
    aliases: string[] = [],
  ): CommandOption => ({
    name,
    action,
    aliases,
    source: "builtin",
    priority: 20,
  });
  const unsupported = (
    name: string,
    description: string,
    aliases: string[] = [],
  ): CommandOption => ({
    name,
    description,
    aliases,
    source: "builtin",
    priority: 20,
    unavailable: "not supported yet",
  });
  return [
    bound("compact", "session.compact", ["summarize"]),
    bound("new", "session.new", ["clear"]),
    bound("undo", "session.undo"),
    bound("redo", "session.redo"),
    bound("fork", "session.fork"),
    bound("rename", "session.rename"),
    unsupported("timeline", "Jump to a message"),
    unsupported("export", "Export the transcript"),
    unsupported("copy", "Copy the whole transcript"),
    bound("model", "model.choose", ["models", "mo"]),
    bound("agent", "agent.cycle"),
    bound("agents", "agent.choose"),
    bound("variants", "variant.choose"),
    unsupported("connect", "Connect a provider or integration"),
    unsupported("mcp", "Choose MCP servers", ["mcps"]),
    unsupported("sessions", "Switch sessions", ["resume", "continue"]),
    unsupported("open", "Open a file"),
    unsupported("status", "Show native service status"),
    unsupported("debug", "Show native diagnostics"),
    bound("themes", "theme.open"),
    unsupported("help", "Show native help"),
    bound("editor", "prompt.editor"),
    bound("skills", "skill.choose"),
    unsupported("terminal", "Open a terminal"),
    unsupported("diff", "Open the diff viewer"),
    unsupported("update", "Update the native application"),
    unsupported("exit", "Exit the terminal application", ["quit", "q"]),
    unsupported("org", "Switch Console organization", ["orgs", "switch-org"]),
    unsupported("workspace", "Toggle workspaces"),
    unsupported("workspaces", "Manage workspaces"),
    unsupported("warp", "Select a workspace"),
    unsupported("move", "Move to another directory"),
    bound("timestamps", "prefs.toggle.timestamps", ["toggle-timestamps"]),
    bound("thinking", "prefs.toggle.thinking", ["toggle-thinking"]),
  ];
}
