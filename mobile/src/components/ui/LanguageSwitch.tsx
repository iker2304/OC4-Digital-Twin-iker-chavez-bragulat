/**
 * Selector de idioma: ES · EN · CA.
 *
 * Tres botones y no un desplegable: son tres opciones cortas y fijas, y así el
 * cambio está a un toque tanto en móvil como en escritorio. El idioma se guarda
 * en el store (persistido) desde `useI18n().setLang`.
 */
import { Languages } from 'lucide-react';
import { LANGUAGES, useI18n } from '../../i18n';
import { cn } from '../../lib/cn';

export function LanguageSwitch({ className }: { className?: string }) {
    const { lang, setLang, t } = useI18n();

    return (
        <div
            role="group"
            aria-label={t('lang.switch')}
            title={t('lang.switch')}
            className={cn(
                'pointer-events-auto inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-slate-900/70 p-0.5 backdrop-blur',
                className
            )}
        >
            <Languages className="mx-1 h-3.5 w-3.5 text-slate-500" aria-hidden />
            {LANGUAGES.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    onClick={() => setLang(option.id)}
                    aria-pressed={lang === option.id}
                    className={cn(
                        'rounded-md px-1.5 py-1 text-[11px] font-semibold transition-colors',
                        lang === option.id
                            ? 'bg-sky-500/25 text-sky-100'
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                    )}
                >
                    {option.short}
                </button>
            ))}
        </div>
    );
}
