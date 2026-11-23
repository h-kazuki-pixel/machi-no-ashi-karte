// 停留所の名前で探す（ひらがな・カタカナ・半角カナ・全角英数をそろえて比べる）
export function norm(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s/g, "")
    .toLowerCase();
}

export function searchStops(P, q, { exclude = null, limit = 30 } = {}) {
  const v = norm(q);
  return [...P.groups.values()]
    .filter((g) => g.inOld || g.inNew)
    .filter((g) => g.name !== exclude)
    .filter((g) => !v || norm(g.name).includes(v) || norm(g.kana).includes(v) || [...g.oldNames].some((o) => norm(o).includes(v)))
    .sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"))
    .slice(0, limit);
}
