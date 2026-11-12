import type { GuideDiagnostic, GuideRender } from './contract';

/** Canonical journal source. Page title remains the material's versioned title. */
export type JournalTone = 'neutral' | 'info' | 'success' | 'warning';
export type JournalCover =
  | { kind: 'poster'; eyebrow: string; title: string; caption: string; tone: 'yellow' | 'mint' | 'peach' | 'sky' | 'lilac' }
  | { kind: 'image'; file_id: string; alt: string; caption: string; width: number; height: number };
export type JournalBlock =
  | { id: string; type: 'text'; body: string }
  | { id: string; type: 'note'; tone: JournalTone; title: string; body: string }
  | { id: string; type: 'comparison'; before_label: string; before: string; after_label: string; after: string }
  | { id: string; type: 'facts'; items: { label: string; body: string }[] }
  | { id: string; type: 'steps'; items: { role: string; title: string; body: string }[] }
  | { id: string; type: 'image'; file_id: string; alt: string; caption: string; width: number; height: number; collapsed: boolean }
  | { id: string; type: 'disclosure'; title: string; body: string }
  | { id: string; type: 'switcher'; title: string; options: { id: string; label: string; body: string }[] }
  | { id: string; type: 'legacy'; body: string };
export interface JournalSection { id: string; label: string; title: string; blocks: JournalBlock[] }
export interface JournalDocument { version: 1; eyebrow: string; intro: string; cover: JournalCover | null; sections: JournalSection[] }
export interface JournalRender {
  schema_version: 2;
  policy_version: 1;
  source_hash: string;
  document: JournalDocument | null;
  legacy: { block_id: string; render: GuideRender }[];
  diagnostics: GuideDiagnostic[];
  file_ids: string[];
  image_file_ids: string[];
}
