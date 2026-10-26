export type EditorShortcut = "b" | "i" | "k" | "s" | "z" | "y";

type KeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

const physical: Record<string, EditorShortcut> = {
  KeyB: "b", KeyI: "i", KeyK: "k", KeyS: "s", KeyZ: "z", KeyY: "y",
};
const commands = new Set<EditorShortcut>(["b", "i", "k", "s", "z", "y"]);

/** Physical keys keep editor commands usable with Russian and other keyboard layouts. */
export function editorShortcut(event: KeyEvent): EditorShortcut | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing ||
      event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return null;
  const code = physical[event.code ?? ""];
  if (code) return code;
  const key = event.key.toLowerCase() as EditorShortcut;
  return commands.has(key) ? key : null;
}
