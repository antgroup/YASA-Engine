export interface ClassHierarchy {
  typeDeclaration: string
  type: string
  value: any
  extends: ClassHierarchy[]
  extendedBy: ClassHierarchy[]
  implements: ClassHierarchy[]
  implementedBy: ClassHierarchy[]
}
