import { DescriptionData } from '../types.js'

const getExports = (description: string) => {
  const exported = description.match(/^export [A-z0-9 ]+ \([\s\S]*?\n\)$/gm)
  if (exported === null) return new Map<string, string>()

  return exported.reduce((acc, exportText) => {
    const lines = exportText.split('\n')
    const exportName = lines[0].replace(/export|hidden|\(.*/gi, '').trim()
    lines.splice(0, 1)
    lines.splice(-1, 1)

    acc.set(exportName, lines.join('\n'))
    return acc
  }, new Map<string, string>())
}

export const loadExports = (descriptionData: DescriptionData): string => {
  const { descriptionString, editorType, language, hash, database } = descriptionData
  let description = descriptionString

  const getImports = (descriptionString: string) => {
    if (!descriptionString.includes('import')) return null

    const imports = [
      ...(descriptionString.match(/^import [A-z0-9 ]+? from (\d+|global) *?$/gm) || []),
      ...(descriptionString.match(/^import self *?$/gm) || [])
    ]

    return imports.flatMap((importLine) => {
      const importSelf = importLine.includes('import self')
      if (importSelf) {
        return {
          line: importLine,
          name: 'self',
          from: ''
        }
      }

      const name = importLine.match(/(?<=import) .+ (?=from)/)?.[0].trim()
      const from = importLine.match(/(?<=from) (\d+|global)/)?.[0].trim()

      if (name === undefined || from === undefined) return []
      return {
        line: importLine,
        name: importLine.match(/(?<=import) .+ (?=from)/)?.[0].trim() || '',
        from: importLine.match(/(?<=from) (\d+|global)/)?.[0].trim() || ''
      }
    })
  }

  const replaceImports = (importsInDescription: { line: string; name: string; from: string }[]) => {
    importsInDescription.forEach(({ line, name, from }) => {
      const editorToImportFrom = editorType === 'main' ? 'secondary' : 'main'

      if (name === 'self') {
        const imported = database[hash]?.editor[language]?.[editorToImportFrom]
        if (imported === undefined) throw new Error(`Missing self import for ${hash}/${language}/${editorToImportFrom}`)
        description = description.replace(line, () => imported.trim())
        return
      }

      if (name === 'main' || name === 'secondary') {
        const imported = database[from]?.editor[language]?.[name]
        if (imported === undefined) throw new Error(`Missing import ${name} from ${from} for ${hash}/${language}`)
        description = description.replace(line, () => imported)
        return
      }

      if (from === 'global') {
        const globalExports = new Map([
          ...getExports(database[1]?.editor[language]?.main || ''),
          ...getExports(database[1]?.editor[language]?.secondary || '')
        ])
        const imported = globalExports.get(name)
        if (imported === undefined) throw new Error(`Missing global export ${name} for ${hash}/${language}`)
        description = description.replace(line, () => imported)
        return
      }

      const imported = getExports(database[from]?.editor[language]?.[editorToImportFrom] || '').get(name)
      if (imported === undefined) throw new Error(`Missing export ${name} from ${from} for ${hash}/${language}`)
      description = description.replace(line, () => imported)
    })
  }

  // just to be safe limiting to 5 times
  for (let i = 0; i < 5; i++) {
    const importsFound = getImports(description)
    if (importsFound === null) break
    replaceImports(importsFound)
  }

  if (getImports(description)?.length) throw new Error(`Unresolved or cyclic imports for ${hash}/${language} after 5 passes`)

  return description
}
