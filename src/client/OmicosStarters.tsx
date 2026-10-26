import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface Starter {
  title: string
  hint: string
  prompt: string
}
const GROUPS: ReadonlyArray<{
  id: string
  label: string
  items: readonly Starter[]
}> = [
  {
    id: 'analysis',
    label: '常用分析',
    items: [
      {
        title: '单细胞聚类与注释',
        hint: '质控、降维、聚类，给出细胞类型建议',
        prompt:
          '帮我对当前项目里的单细胞数据做质控、降维聚类，并给出每个细胞群的类型注释建议。'
      },
      {
        title: '差异表达分析',
        hint: '两组比较，火山图和前 20 个基因',
        prompt:
          '对我的表达矩阵做两组差异表达分析，画火山图，并列出变化最显著的前 20 个基因。'
      },
      {
        title: '富集分析',
        hint: 'GO / KEGG 富集并画气泡图',
        prompt: '对差异基因做 GO 和 KEGG 富集分析，并画成气泡图。'
      },
      {
        title: '全基因组关联分析',
        hint: '按固定流程跑 GWAS，画曼哈顿图',
        prompt: '用我的基因型和表型数据按固定流程跑一遍全基因组关联分析，并画曼哈顿图。'
      }
    ]
  },
  {
    id: 'prepare',
    label: '数据准备',
    items: [
      {
        title: '看看项目里有什么数据',
        hint: '判断每个文件的格式和用途',
        prompt: '看一下项目数据盘里有哪些文件，帮我判断每个文件的格式和用途。'
      },
      {
        title: '导入并检查表格',
        hint: '缺失值、异常值和整体概况',
        prompt: '把我上传的 CSV 导入进来，检查缺失值和异常值，并总结数据的整体情况。'
      },
      {
        title: '整理成可复现的 Notebook',
        hint: '把刚才的分析写成 Notebook',
        prompt: '把刚才的分析整理成一个可以重新运行的 Notebook。'
      },
      {
        title: '拼成论文多面板图',
        hint: '把几张结果图排成一张',
        prompt: '把几张结果图拼成一张论文用的多面板图，并导出矢量格式。'
      }
    ]
  }
]

function fill(prompt: string): void {
  const editor = document.querySelector<HTMLElement>(
    '[class*="_composerHero"] [contenteditable="true"], [class*="_composerHero"] textarea'
  )
  if (!editor) return
  editor.focus()
  if (editor instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set
    setter?.call(editor, prompt)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  document.execCommand('selectAll')
  document.execCommand('insertText', false, prompt)
}

/** "下一步可以研究什么": local starter prompts under the blank-session composer. */
export function OmicosStarters(): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [group, setGroup] = useState(GROUPS[0].id)
  useEffect(() => {
    let mount: HTMLElement | null = null
    const sync = (): void => {
      const hero = document.querySelector<HTMLElement>('[class*="_composerHero"]')
      if (!hero) {
        if (mount) {
          mount.remove()
          mount = null
          setHost(null)
        }
        return
      }
      if (mount?.parentElement === hero) return
      mount?.remove()
      mount = document.createElement('div')
      mount.dataset.omicosStarters = ''
      hero.append(mount)
      setHost(mount)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mount?.remove()
      setHost(null)
    }
  }, [])
  if (!host) return null
  const active = GROUPS.find((item) => item.id === group) ?? GROUPS[0]
  return createPortal(
    <section className="omicos-starters" aria-label="下一步可以研究什么">
      <h2>下一步可以研究什么</h2>
      <div className="omicos-starters-tabs" role="tablist">
        {GROUPS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active.id}
            onClick={() => setGroup(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <ul>
        {active.items.map((item) => (
          <li key={item.title}>
            <button type="button" onClick={() => fill(item.prompt)}>
              <strong>{item.title}</strong>
              <span>{item.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>,
    host
  )
}
