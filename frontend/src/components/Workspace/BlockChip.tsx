import { useQuery } from "@tanstack/react-query";
import type { BlockRef } from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { canRetainData } from "../../utils/api/request";
import { getBlockRoute } from "../../utils/routes";
import { ChipAvatar, ChipInitials } from "./ChipFace";
import { HoverCard } from "./HoverCard";
import { InteractiveChip } from "./InteractiveChip";
import { UserChip } from "./UserChip";
import s from "./BlockChip.module.css";

/** Display chips never fetch, navigate or open a preview inside selection controls. */
export function BlockChip({ block, interactive = true, className = "" }: { block: BlockRef; interactive?: boolean; className?: string }) {
  const face = { label: block.name, avatarUrl: block.avatar_url, avatarFallback: <ChipInitials name={block.name} /> };
  if (!interactive) return <InteractiveChip kind="display" {...face} className={className} />;
  return <HoverCard className={className} content={() => <BlockPreview block={block} />}>{({ describedBy, close }) =>
    <InteractiveChip kind="link" to={getBlockRoute(block.block_id)} {...face} ariaDescribedBy={describedBy} onClick={close} />
  }</HoverCard>;
}
function BlockPreview({ block }: { block: BlockRef }) {
  const query = useQuery({ queryKey: ["workspaceBlocks", block.block_id], queryFn: () => membershipApi.block(block.block_id) });
  if (query.error && !canRetainData(query.error)) return <p className={s.hint}>Блок недоступен.</p>;
  const current = query.data;
  if (!current) return <p className={s.hint}>{query.isLoading ? "Загружаем блок…" : "Сведения о блоке недоступны."}</p>;
  return <>
    <div className={s.identity}><ChipAvatar src={current.avatar_url} large fallback={<ChipInitials name={current.name} />} /><div><strong>{current.name}</strong><small>Блок Профкома</small></div></div>
    <dl className={s.details}><div><dt>Мастер</dt><dd>{current.master ? <UserChip user={current.master.user} interactive={false} /> : "Не назначен"}</dd></div><div><dt>Участников</dt><dd>{current.members.length}</dd></div></dl>
  </>;
}
