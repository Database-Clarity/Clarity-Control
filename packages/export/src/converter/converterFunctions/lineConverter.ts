import { classNameList } from '../data.js'
import { CellContent, DescriptionLine, LinesContent } from '../types.js'

export const convertLinesContent = (line: string, tiles: { [key: string]: DescriptionLine[] }) => {
  const splittedLine = line.split(/(<(?:blue|green|purple|yellow|center|bold|pve|pvp|background) (?:(?:<arrow\/>)|[^<>])*? \/>|<.+?\/>|🡅)/g).filter((line) => line !== '')
  return splittedLine.reduce((acc, text) => {
    if (text === '<arrow/>') {
      acc.push({ classNames: ['arrow'] })
      return acc
    }
    if (text === '🡅') {
      acc.push({
        text: '🡅',
        classNames: ['enhancedArrow']
      })
      return acc
    }

    const wrappersName = text.match(/<\w+/)?.[0].replace('<', '')

    // if there are no special stuff return text
    if (wrappersName === undefined) {
      acc.push({
        text
      })
      return acc
    }

    const { empty, withText } = classNameList

    // wrapper with text inside
    if (withText.includes(wrappersName as (typeof withText)[number])) {
      if (text.includes('<arrow/>')) {
        const inner = text.replace(new RegExp(`^<${wrappersName} | />$`, 'g'), '')
        for (const part of inner.split(/(<arrow\/>)/).filter(Boolean))
          acc.push(part === '<arrow/>' ? { classNames: [wrappersName, 'arrow'] } : { text: part, classNames: [wrappersName] })
      } else acc.push({
        text: text.replace(new RegExp(`<${wrappersName} | />`, 'g'), ''),
        classNames: [wrappersName]
      })
      return acc
    }

    // wrapper with out text inside
    if (empty.includes(wrappersName as (typeof empty)[number])) {
      acc.push({
        classNames: [wrappersName]
      })
      return acc
    }

    const wrapperContent = text.match(/\[.+\]/)?.[0].replace(/\[|\]/g, '')
    const wrapperText = text.replace(/ \[.+\] \/>/g, '')

    if (!wrapperContent || !wrapperText) return acc

    if (wrappersName === 'link') {
      acc.push({
        text: wrapperText.replace('<link ', ''),
        link: wrapperContent,
        classNames: ['link']
      })
      return acc
    }
    if (wrappersName === 'formula') {
      acc.push({
        text: wrapperText.replace(/<formula ?/, ''),
        formula: wrapperContent,
        classNames: ['formula']
      })
      return acc
    }
    if (wrappersName === 'title') {
      acc.push({
        text: wrapperText.replace('<title ', ''),
        title: tiles[wrapperContent],
        classNames: ['title']
      })
      return acc
    }

    return acc
  }, [] as LinesContent[] | CellContent[])
}
