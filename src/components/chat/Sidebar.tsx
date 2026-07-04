"use client";

import { useState } from "react";
import {
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  Check,
  X,
  PanelLeftClose,
  Sun,
  Moon,
  LogOut,
  Download,
} from "lucide-react";
import { useChatStore, type Conversation } from "@/store/chat";
import { useAuth } from "@/store/auth";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SidebarProps {
  onClose?: () => void;
}

/**
 * Build a Markdown representation of a conversation and trigger a browser
 * download. Useful for saving a chat for later reference, sharing with a
 * teammate, or pasting into another tool.
 */
function exportConversationAsMarkdown(convo: Conversation) {
  const date = new Date(convo.createdAt).toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# ${convo.title || "Untitled conversation"}`);
  lines.push("");
  lines.push(
    `_Exported ${new Date().toLocaleString()} · ${convo.messages.length} messages_`
  );
  if (convo.videoContext) {
    lines.push("");
    lines.push(`**Video context:** [${convo.videoContext.title}](${convo.videoContext.url})`);
    lines.push(`**Channel:** ${convo.videoContext.author}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const m of convo.messages) {
    const time = new Date(m.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (m.role === "user") {
      lines.push(`## 🧑 You · ${time}`);
    } else {
      lines.push(`## 🤖 Assistant · ${time}`);
    }
    if (m.youtubeMeta) {
      lines.push("");
      lines.push(
        `> ▶️ **YouTube:** [${m.youtubeMeta.url}](${m.youtubeMeta.url})  ` +
          `· ⏱ ${m.youtubeMeta.startTime ?? "0:00"} → ${m.youtubeMeta.endTime ?? "end"}`
      );
    }
    if (m.attachments && m.attachments.length > 0) {
      lines.push("");
      lines.push(
        `_Attachments: ${m.attachments.map((a) => a.name).join(", ")}_`
      );
    }
    lines.push("");
    lines.push(m.content || "_(empty)_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const md = lines.join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = (convo.title || "conversation")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  a.href = url;
  a.download = `${date}-${safeTitle || "chat"}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function Sidebar({ onClose }: SidebarProps) {
  const {
    conversations,
    activeId,
    createConversation,
    deleteConversation,
    renameConversation,
    setActive,
  } = useChatStore();

  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const handleLogout = async () => {
    await logout();
  };

  const displayName = user?.name ?? "User";
  const displayEmail = user?.email ?? "";
  const initials = displayName.charAt(0).toUpperCase() || "U";

  const handleNew = () => {
    createConversation();
    onClose?.();
  };

  const handleSelect = (id: string) => {
    setActive(id);
    onClose?.();
  };

  const handleExport = (convo: Conversation) => {
    exportConversationAsMarkdown(convo);
  };

  const startEditing = (id: string, current: string) => {
    setEditingId(id);
    setDraftTitle(current);
  };

  const commitEdit = (id: string) => {
    renameConversation(id, draftTitle.trim());
    setEditingId(null);
    setDraftTitle("");
  };

  return (
    <aside className="flex h-full w-full flex-col bg-zinc-50 dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between p-3">
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Close sidebar"
        >
          <PanelLeftClose className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
        </button>
        <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500 px-2">
          Menu
        </span>
      </div>

      {/* New chat button */}
      <div className="px-3 pb-2">
        <button
          onClick={handleNew}
          className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
      </div>

      {/* Conversation list */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 chatgpt-scroll">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
          Chats
        </p>
        {conversations.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-zinc-400 dark:text-zinc-600">
            No conversations yet.
            <br />
            Start a new chat to begin.
          </div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {conversations.map((c) => {
              const isActive = c.id === activeId;
              const isEditing = editingId === c.id;
              return (
                <li key={c.id}>
                  <div
                    className={cn(
                      "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer",
                      isActive
                        ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-white"
                        : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    )}
                    onClick={() => !isEditing && handleSelect(c.id)}
                  >
                    <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-70" />

                    {isEditing ? (
                      <div className="flex flex-1 items-center gap-1">
                        <Input
                          autoFocus
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(c.id);
                            if (e.key === "Escape") {
                              setEditingId(null);
                              setDraftTitle("");
                            }
                          }}
                          className="h-6 px-1 py-0 text-sm"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            commitEdit(c.id);
                          }}
                          className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                            setDraftTitle("");
                          }}
                          className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="flex-1 truncate">{c.title}</span>
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExport(c);
                            }}
                            className="p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700"
                            aria-label="Export as Markdown"
                            title="Export as Markdown"
                          >
                            <Download className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(c.id, c.title);
                            }}
                            className="p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700"
                            aria-label="Rename"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteConversation(c.id);
                            }}
                            className="p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 hover:text-red-500"
                            aria-label="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* Footer — user menu */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-xs font-bold text-white flex-shrink-0">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                  {displayName}
                </p>
                {displayEmail && (
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                    {displayEmail}
                  </p>
                )}
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="top"
            className="w-56"
            sideOffset={4}
          >
            <DropdownMenuLabel className="truncate">
              {displayEmail || displayName}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="cursor-pointer"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="mr-2 h-4 w-4" />
                  <span>Light mode</span>
                </>
              ) : (
                <>
                  <Moon className="mr-2 h-4 w-4" />
                  <span>Dark mode</span>
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const c = conversations.find((x) => x.id === activeId);
                if (c) exportConversationAsMarkdown(c);
              }}
              className="cursor-pointer"
              disabled={!activeId}
            >
              <Download className="mr-2 h-4 w-4" />
              <span>Export current chat</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer text-red-600 dark:text-red-400 focus:text-red-700 dark:focus:text-red-300"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
