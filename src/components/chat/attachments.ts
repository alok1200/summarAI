"use client";

import type { Attachment } from "@/store/chat";

export const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
export const MAX_FILES = 6;

const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
];

const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "json", "csv", "tsv", "js", "jsx",
  "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h",
  "hpp", "cs", "php", "swift", "kt", "scala", "sh", "bash",
  "yml", "yaml", "xml", "html", "htm", "css", "scss", "less",
  "sql", "graphql", "toml", "ini", "env", "log", "conf",
  "gitignore", "dockerfile", "makefile",
];

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml"];

function getExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isTextFile(file: File): boolean {
  const ext = getExtension(file.name);
  if (TEXT_EXTENSIONS.includes(ext)) return true;
  return TEXT_MIME_PREFIXES.some((p) => file.type.startsWith(p));
}

function isImageFile(file: File): boolean {
  return IMAGE_TYPES.includes(file.type);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export interface ProcessResult {
  attachments: Attachment[];
  errors: string[];
}

export async function processFiles(files: File[]): Promise<ProcessResult> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`"${file.name}" is too large (max 8MB).`);
      continue;
    }

    try {
      if (isImageFile(file)) {
        const dataUrl = await readAsDataUrl(file);
        attachments.push({
          id: genId(),
          name: file.name,
          mimeType: file.type,
          size: file.size,
          kind: "image",
          dataUrl,
        });
      } else if (isTextFile(file)) {
        // Truncate very large text content
        let text = await readAsText(file);
        if (text.length > 100_000) {
          text = text.slice(0, 100_000) + "\n\n[... file truncated ...]";
        }
        attachments.push({
          id: genId(),
          name: file.name,
          mimeType: file.type || "text/plain",
          size: file.size,
          kind: "text",
          textContent: text,
        });
      } else {
        errors.push(
          `"${file.name}" is not supported. Try images (PNG, JPEG, GIF, WebP) or text/code files.`
        );
      }
    } catch {
      errors.push(`Could not read "${file.name}".`);
    }
  }

  return { attachments, errors };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
