import { cleanObject } from './helpers.js'

import { getSettings } from './converterSettings.js'
import { AllClassNames, DescriptionLine } from './types.js'

export const cleanDescription = <T>(obj: T, converterType: string): T => {
  const { getFromDescription, enhancedArrowReplacement } = getSettings(converterType)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remover = (obj: any) => {
    for (const key in obj) {
      if (key === 'text') {
        // replace enhanced arrow text
        if (enhancedArrowReplacement !== undefined && obj[key] === '🡅') {
          obj[key] = enhancedArrowReplacement
          continue
        }

        // replace PVP text
        if (obj.classNames?.includes('pvp') && !getFromDescription.includeClassNames?.includes('pvp')) {
          const pvpText = obj[key]
            .match(/\[.+?\]/g)?.[0]
            .replace(/\[|\]/g, '')
          if (pvpText === null) continue

          obj[key] = obj[key].replace(pvpText, `PVP: ${pvpText}`)
          continue
        }
      }

      // filter out classNames
      if (key === 'classNames') {
        obj[key] = obj[key]?.filter((className: AllClassNames) => {
          return getFromDescription.includeClassNames?.includes(className)
        })
        continue
      }
      // remove link, title, table if settings say so
      if (!getFromDescription.link && key === 'link') {
        delete obj[key]
        continue
      }
      if (!getFromDescription.title && key === 'title') {
        delete obj[key]
        continue
      }
      if (!getFromDescription.table && key === 'table') {
        delete obj[key]
        continue
      }

      // remove formulas
      // eslint-disable-next-line no-prototype-builtins
      if (obj[key]?.hasOwnProperty('formula') || obj[key]?.hasOwnProperty('isFormula')) {
        if (!getFromDescription.formula) {
          delete obj[key]
          continue
        }
      }

      if (!obj[key] || typeof obj[key] !== 'object') continue
      remover(obj[key])
    }
    return obj
  }
  return remover(obj)
}

const descriptionToString = (description: DescriptionLine[] | undefined, converterType: string) => {
  const options = getSettings(converterType).toStringConverterOptions
  return description
    ?.reduce((acc, line) => {
      if (line.classNames?.includes('spacer')) return (acc = acc + '\n')

      const newLine = line.linesContent?.reduce((acc, linesContent) => {
        if (linesContent.link && options?.link) {
          const [textStart, textEnd, linkStat, linkEnd] = options.link
          acc = acc + `${textStart}${linesContent.text}${textEnd}` + `${linkStat}${linesContent.link}${linkEnd}`
          return acc
        }

        if (linesContent.classNames && linesContent.classNames?.length !== 0 && options?.classNames) {
          const newText = linesContent.classNames.reduce((acc, className) => {
            if (className === undefined) return acc
            const [classNameStart, classNameEnd] = options.classNames?.[
              className as keyof typeof options.classNames
            ] || ['', '']
            acc = acc + `${classNameStart}${linesContent.text || ''}${classNameEnd}`
            return acc
          }, '')
          acc = acc + newText
          return acc
        }
        acc = acc + linesContent.text
        return acc
      }, '')

      if (line.classNames && line.classNames?.length !== 0 && options?.classNames) {
        const lineWithClassNames = line.classNames.reduce((acc, className) => {
          if (className === undefined) return acc
          const [classNameStart, classNameEnd] = options.classNames?.[className as keyof typeof options.classNames] || [
            '',
            ''
          ]
          acc = acc + `${classNameStart}${newLine}${classNameEnd}`
          return acc
        }, '')
        acc = acc + '\n' + lineWithClassNames
        return acc
      }

      acc = acc + '\n' + newLine
      return acc
    }, '')
    .trim()
}

// Old cached descriptions may still carry section metadata. Keep the section as
// ordinary text, and remove the structural markers at every description level.
const normalizeLegacySections = (lines: DescriptionLine[] | undefined): DescriptionLine[] | undefined => {
  if (!lines) return lines
  let previousSection: string | undefined
  return lines.flatMap((line) => {
    const { weaponTypes, weaponBlock, weaponOther, ...body } = line
    const label = weaponOther ? 'Other' : weaponTypes?.filter(Boolean).join(', ')
    const section = label ? `${weaponBlock ?? ''}:${label}` : undefined
    const heading: DescriptionLine[] = section && section !== previousSection
      ? [{ linesContent: [{ text: `${label}:` }] }]
      : []
    previousSection = section
    body.linesContent?.forEach((content) => { content.title = normalizeLegacySections(content.title) })
    body.table?.forEach((row) => row.rowContent?.forEach((cell) =>
      cell.cellContent?.forEach((content) => { content.title = normalizeLegacySections(content.title) })))
    return [...heading, body]
  })
}

export const descriptionFilter = (description: DescriptionLine[] | undefined, converterType: string) => {
  const { toStringConverterOptions } = getSettings(converterType)
  const newDescription = cleanObject(cleanDescription(normalizeLegacySections(description), converterType))

  // remove spacer from end of description
  let removeSpacer = true
  const finalDescription = newDescription?.reduceRight((acc: DescriptionLine[], line: DescriptionLine) => {
    if (line.classNames?.includes('spacer') && removeSpacer) return acc

    removeSpacer = false
    acc.unshift(line)
    return acc
  }, [])

  if (!toStringConverterOptions) return finalDescription

  return descriptionToString(finalDescription, converterType)
}
