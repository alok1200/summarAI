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
} from "lucide-react";
import { useChatStore } from "@/store/chat";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SidebarProps {
  onClose?: () => void;
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const handleNew = () => {
    createConversation();
    onClose?.();
  };

  const handleSelect = (id: string) => {
    setActive(id);
    onClose?.();
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
        <Button
          variant="ghost"
          size="icon"
          className="rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </div>

      {/* New chat button */}
      <div className="px-3 pb-2">
        <button
          onClick={handleNew}
          className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
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

      {/* Footer */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-xs font-bold text-white">
            U
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
              User
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
