import { useCallback, useRef, useState } from "react";
import type { Material } from "../../utils/api/contract";
import { materialsApi } from "../../utils/api/materials.api";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can } from "../../utils/session";
import { AnchoredPopover } from "./AnchoredPopover";
import { InteractiveChip } from "./InteractiveChip";
import { Glyph } from "./WorkspaceUI";
import { recordOwnChange, useOwnRevisions } from "./ownRevisions";
import s from "./Workspace.module.css";

const labels = { block: "Только свой блок", everyone: "Все активисты" } as const;

/** A visibility command neither saves the text editor nor publishes its draft. */
export function MaterialAudience({ material }: { material: Material }) {
  const anchor = useRef<HTMLSpanElement>(null), saving = useRef(false);
  const [revision, setRevision] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { perform, refresh } = useWorkspaceActions(), own = useOwnRevisions();
  const close = useCallback(() => { if (!saving.current) { setRevision(null);setError(""); } }, []);
  if (!material.audience) return null;
  const editable = can(material, "edit_audience"), current = material.audience;
  const choose = async (audience: "block" | "everyone") => {
    if (!editable || saving.current || revision === null) return;
    if (audience === current) { close();return; }
    saving.current = true;setBusy(true);setError("");
    try {
      await perform(async () => {
        const result = await materialsApi.audience(material.material_id, audience, { expected_revision: revision });
        recordOwnChange(own, `material:${material.material_id}`, revision, result.revision);
        own.setQueryData(["materials", material.material_id], result);
      });
      setRevision(null);
    } catch (failure) { setError(userMessage(failure));await refresh(); }
    finally { saving.current = false;setBusy(false); }
  };
  return <>
    {editable ? <InteractiveChip anchorRef={anchor} kind="action" label={labels[current]} icon={<Glyph name="visibility" />}
      onClick={() => { setError("");setRevision(material.revision); }} expanded={revision !== null} hasPopup="dialog" />
      : <InteractiveChip kind="display" label={labels[current]} icon={<Glyph name="visibility" />} />}
    <AnchoredPopover open={revision !== null && editable} anchorRef={anchor} label="Кто видит гайд" onRequestClose={close} busy={busy} width={330}>
      <div className={s.stack} role="group" aria-label="Видимость гайда">
        {(Object.keys(labels) as (keyof typeof labels)[]).map(value => <button key={value} type="button" className={s.button} aria-pressed={current === value} disabled={busy} onClick={() => { void choose(value); }}>{labels[value]}</button>)}
        {error && <p className={s.error} role="alert">{error}</p>}
      </div>
    </AnchoredPopover>
  </>;
}
