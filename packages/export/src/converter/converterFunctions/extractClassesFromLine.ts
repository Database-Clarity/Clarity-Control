export const getLineClasses = (line: string, classNamesArray: string[]) => {
  const classNames = classNamesArray.flatMap((className) => {
    const updatedClassName = `<${className}/>`
    if (line.match(new RegExp(updatedClassName)) === null) return []
    return className
  })
  const cleanLine = classNames.reduce((acc, className) => {
    acc = acc.replace(new RegExp(`<${className}/>`), '')
    return acc
  }, line)

  return {
    classNames,
    cleanLine
  }
}
