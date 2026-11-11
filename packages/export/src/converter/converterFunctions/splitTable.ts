import { classNameList } from '../data.js'
import { CellContent, DescriptionLine } from '../types.js'
import { getLineClasses } from './extractClassesFromLine.js'
import { convertLinesContent } from './lineConverter.js'

export const splitTable = (line: string, title: { [key: string]: DescriptionLine[] }) => {
  const { classNames, cleanLine } = getLineClasses(line, classNameList.empty)

  // line splitted on |
  const splittedLine = cleanLine.match(/\|.*?((?=\|)|$)/g) || []

  return {
    classNames,
    rowContent: splittedLine.map((tableCell) => {
      const cellSpan = tableCell.match(/\|([bchr\d-]+)?/)?.[0]?.match(/-\d|\d/g)
      const colSpan = cellSpan?.filter((number) => Number(number) > 0)[0]
      const rowSpan = cellSpan?.filter((number) => Number(number) < 0)[0]

      const inCellClasses: { [key: string]: string } = {
        b: 'bold',
        c: 'center',
        h: 'background',
        r: 'right'
      }

      const cellClassNames = tableCell
        .match(/\|[bchr\d-]+/)?.[0]
        .split('')
        .filter((char) => inCellClasses[char] !== undefined)
        .map((c) => inCellClasses[c])

      tableCell = tableCell.replace(/\|[bchr\d-]+|\|/, '').trim()

      const convertCellContent: CellContent[] = convertLinesContent(tableCell, title)

      const cleanedCell = convertCellContent.flatMap((span) => {
        if (
          (span.text === undefined || span.text.trim() === '') &&
          (span.classNames === undefined || !span.classNames?.some((className) => typeof className === 'string'))
        )
          return []
        return {
          text: span.text,
          classNames: span.classNames,
          formula: span.formula,
          title: span.title
        }
      })

      return {
        colSpan: colSpan ? Number(colSpan) : undefined,
        rowSpan: rowSpan ? Number(rowSpan) * -1 : undefined,
        classNames: cellClassNames,
        cellContent: cleanedCell
      }
    })
  }
}
