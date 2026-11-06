/**
 * Traducciones de la interfaz.
 *
 * Tres idiomas con el castellano como referencia: `Dict` se deriva de `es.ts`,
 * así que añadir una clave allí y olvidarla en otro idioma es un error de
 * compilación, no una sorpresa en producción.
 *
 * Uso:
 *   const { t, lang, setLang } = useI18n();
 *   <h2>{t('hero.title.b')}</h2>
 *
 * El idioma se guarda en el store y en `localStorage`, así que sobrevive a las
 * recargas sin tocar la URL.
 */
import { useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { es, type Dict } from './es';
import { en } from './en';
import { ca } from './ca';
import { zh } from './zh';
import { saveLanguage, type Lang } from './language';

export type { Lang } from './language';
export { LANGUAGES, detectLanguage, loadLanguage } from './language';
export type TranslationKey = keyof Dict;

const DICTS: Record<Lang, Dict> = { es, en, ca, zh };

/** Traducción sin React, para usar desde fuera de un componente. */
export function translate(lang: Lang, key: TranslationKey): string {
    return DICTS[lang]?.[key] ?? es[key] ?? String(key);
}

export function useI18n(): {
    lang: Lang;
    setLang: (lang: Lang) => void;
    t: (key: TranslationKey) => string;
} {
    const lang = useAppStore((state) => state.language);
    const update = useAppStore((state) => state.update);

    const t = useCallback((key: TranslationKey) => translate(lang, key), [lang]);
    const setLang = useCallback(
        (next: Lang) => {
            saveLanguage(next);
            update({ language: next });
        },
        [update]
    );

    return { lang, setLang, t };
}
