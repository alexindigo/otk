// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandOption } from "@otk/protocol";

/** Native 2.2.6 app/TUI registrations. The app merges server commands first. */
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
    priority: 10,
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
    priority: 10,
    unavailable: "not supported yet",
  });
  return [
    bound("compact", "session.compact"),
    bound("new", "session.new"),
    unsupported("clear", "Close the current tab and start a new session"),
    bound("undo", "session.undo"),
    bound("redo", "session.redo"),
    bound("fork", "session.fork"),
    bound("rename", "session.rename"),
    unsupported("timeline", "Jump to a message"),
    unsupported("export", "Export the transcript"),
    bound("copy", "reply.copy"),
    bound("model", "model.choose", ["models"]),
    bound("agent", "agent.cycle"),
    bound("agents", "agent.choose"),
    bound("variants", "variant.choose", ["thinking", "effort"]),
    unsupported("connect", "Connect a provider or integration"),
    unsupported("reload", "Reload native configuration"),
    unsupported("mcp", "Choose MCP servers", ["mcps"]),
    unsupported("sessions", "Switch sessions", ["resume", "continue"]),
    unsupported("open", "Open a file, session or project", [
      "projects",
      "project",
    ]),
    unsupported("usage", "Show usage and billing"),
    unsupported("stats", "Show usage statistics"),
    bound("settings", "settings.open"),
    unsupported("status", "Show native service status"),
    unsupported("debug", "Show native diagnostics"),
    bound("themes", "theme.open"),
    unsupported("help", "Show native help"),
    bound("editor", "prompt.editor"),
    bound("skills", "skill.choose"),
    unsupported("worktrees", "Manage worktrees"),
    unsupported("cd", "Change the working directory"),
    unsupported("terminal", "Open a terminal"),
    unsupported("btw", "Ask a side question"),
    unsupported("diff", "Open the diff viewer"),
    unsupported("plugins", "Manage native plugins"),
    unsupported("highlights", "Show release highlights"),
    unsupported("update", "Update the native application"),
    unsupported("pair", "Pair another device", ["web"]),
    unsupported("restart", "Restart the native service"),
    unsupported("exit", "Exit the terminal application", ["quit", "q"]),
  ];
}
