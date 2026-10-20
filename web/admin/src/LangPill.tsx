import { LANG_PILL, type Lang } from './i18n';

export function LangPill({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  return (
    <div className="langs" role="group" aria-label="Language">
      {LANG_PILL.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={lang === id} onClick={() => onLang(id)} lang={id}>{label}</button>
      ))}
    </div>
  );
}
