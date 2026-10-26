import { useCallback, useId, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

function LanguagePreference({
  locale
}: {
  locale: LocaleRuntime
}): JSX.Element {
  const subscribe = useCallback(
    (listener: () => void) => locale.subscribe(listener),
    [locale]
  )
  const snapshot = useSyncExternalStore(subscribe, () => locale.getSnapshot())
  const id = useId()
  const zh = snapshot.active.startsWith('zh')
  const active =
    snapshot.active === 'en' || snapshot.active === 'zh'
      ? `${snapshot.active}-x-omicos`
      : snapshot.active
  const options = snapshot.locales.filter(
    (language) => language.id !== 'en' && language.id !== 'zh'
  )
  return (
    <div className="omicos-language-preference">
      <label htmlFor={id}>{zh ? '语言' : 'Language'}</label>
      <select
        id={id}
        data-omicos-language
        aria-label={zh ? '应用语言' : 'Application language'}
        value={active}
        onChange={(event) => locale.setLocale(event.target.value)}
      >
        {options.map((language) => (
          <option key={language.id} value={language.id}>
            {language.id === 'zh-x-omicos'
              ? '中文'
              : language.id === 'en-x-omicos'
                ? 'English'
                : language.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Keep product variants in the real native Settings row; retain third-party languages. */
export function registerOmicosLanguageRow(ctx: Context): void {
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'language',
        priority: -20,
        order: 0,
        inject: () => ({ locale: ctx.locale })
      },
      LanguagePreference
    )
  )
}
