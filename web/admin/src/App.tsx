import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setCsrf, type Me } from '@medlink/shared/api';
import { loadLang, saveLang, type Lang } from './i18n';
import { SignIn } from '@medlink/shared/SignIn';
import { LinkPage } from '@medlink/shared/LinkPage';
import { Console } from './Console';

export function App() {
  const [lang, setLang] = useState<Lang>(loadLang);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const isLink = window.location.pathname.replace(/\/+$/, '') === '/link';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    saveLang(lang);
  }, [lang]);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me; csrf: string | null }>('GET', '/auth/me');
      setCsrf(r.csrf);
      setMe(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setCsrf(null); setMe(null); }
      else setMe(null);
    }
  }, []);

  useEffect(() => { if (!isLink) void refresh(); }, [isLink, refresh]);

  if (isLink) return <LinkPage audience="company" lang={lang} onLang={setLang} />;
  if (me === undefined) return null;
  if (me === null || me.scope !== 'company')
    return <SignIn audience="company" lang={lang} onLang={setLang} onSignedIn={(u, csrf) => { setCsrf(csrf); setMe(u); }} />;
  return (
    <Console
      lang={lang}
      onLang={setLang}
      me={me}
      onSignedOut={() => { setCsrf(null); setMe(null); }}
    />
  );
}
