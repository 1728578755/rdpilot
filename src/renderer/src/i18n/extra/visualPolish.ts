/**
 * 视觉密度/卡片/列表细节文案（Batch 2 · Agent G）。
 *
 * 只放"视觉系统"自己的 key：不改 zh-CN.ts / en-US.ts，避免与其他并行 Agent
 * 整文件覆盖。新增 key 统一用 `visual.` 前缀；列表通用词条（list.*）也在这里补，
 * 因为 base 字典不在本批次文件所有权内。
 */
export const visualPolishMessages = {
  zh: {
    /* ---------- 设置页：界面细节 ---------- */
    'visual.sectionTitle': '界面细节',
    'visual.sectionDesc': '行高、动效与组件圆角；卡片版式仍在下方「卡片外观」里调整',
    'visual.uiDensity': '界面行密度',
    'visual.densityCompact': '紧凑',
    'visual.densityCompactDesc': '行更矮，一屏看到更多主机',
    'visual.densityComfortable': '标准',
    'visual.densityComfortableDesc': '默认行高，鼠标与触控都顺手',
    'visual.densitySpacious': '宽松',
    'visual.densitySpaciousDesc': '行更高，点击目标更大',
    'visual.motion': '界面动效',
    'visual.motionSystem': '跟随系统',
    'visual.motionSystemDesc': '系统要求减少动效时自动降级',
    'visual.motionAlways': '始终播放',
    'visual.motionAlwaysDesc': '忽略系统的减少动效设置',
    'visual.motionOff': '关闭',
    'visual.motionOffDesc': '只保留必要的状态变化',
    'visual.radius': '组件圆角',
    'visual.radiusDefault': '标准',
    'visual.radiusDefaultDesc': '当前设计的默认圆角',
    'visual.radiusSoft': '柔和',
    'visual.radiusSoftDesc': '更大的圆角，观感更软',
    'visual.radiusSquare': '直角',
    'visual.radiusSquareDesc': '接近零圆角，信息更密集',

    /* ---------- 设置页：列表列管理 ---------- */
    'visual.columnsTitle': '列表列管理',
    'visual.columnsDesc': '选择显示哪些列、调整顺序；列宽可在表头分隔条上直接拖动',
    'visual.columnsReset': '恢复默认列设置',
    'visual.columnsResetHint': '只影响列表视图，不改连接数据',
    'visual.resetOrder': '重置列序',
    'visual.resetWidths': '重置列宽',
    'visual.columnsHint': '双击表头分隔条也可恢复全部列宽；隐藏的列不会丢失顺序',
    'visual.columnWidthValue': '当前列宽 {width} 像素',
    'visual.moveColumnUp': '上移「{column}」列',
    'visual.moveColumnDown': '下移「{column}」列',
    'visual.resizeColumn': '调整「{column}」列宽',
    'visual.resizeColumnHint': '拖动调整「{column}」列宽，双击恢复默认，左右方向键微调',

    /* ---------- 列表/骨架 ---------- */
    'visual.shortcutNew': 'Ctrl N',
    'visual.shortcutSearch': 'Ctrl F',
    'list.tableLabel': '主机列表',
    'list.rowNumber': '序号',
    'visual.loadingHosts': '正在加载主机',

    /* ---------- 右键菜单：复制连接 ---------- */
    'visual.duplicate': '复制连接',
    'visual.duplicateDone': '已复制连接',
    'visual.duplicateDoneDesc': '副本：{name}（不含已保存密码）',
    'visual.duplicateFailed': '复制连接失败'
  },
  en: {
    'visual.sectionTitle': 'Interface details',
    'visual.sectionDesc':
      'Row density, motion and corner radius; card layouts stay under Card appearance below',
    'visual.uiDensity': 'Interface density',
    'visual.densityCompact': 'Compact',
    'visual.densityCompactDesc': 'Shorter rows, more hosts per screen',
    'visual.densityComfortable': 'Standard',
    'visual.densityComfortableDesc': 'Default height, comfortable for mouse and touch',
    'visual.densitySpacious': 'Spacious',
    'visual.densitySpaciousDesc': 'Taller rows with larger hit targets',
    'visual.motion': 'Motion',
    'visual.motionSystem': 'Follow system',
    'visual.motionSystemDesc': 'Reduce when the system asks for it',
    'visual.motionAlways': 'Always',
    'visual.motionAlwaysDesc': 'Ignore the system reduce-motion preference',
    'visual.motionOff': 'Off',
    'visual.motionOffDesc': 'Keep only essential state changes',
    'visual.radius': 'Corner radius',
    'visual.radiusDefault': 'Standard',
    'visual.radiusDefaultDesc': 'The default look',
    'visual.radiusSoft': 'Soft',
    'visual.radiusSoftDesc': 'Larger, softer corners',
    'visual.radiusSquare': 'Square',
    'visual.radiusSquareDesc': 'Near-zero radius for denser information',

    'visual.columnsTitle': 'List columns',
    'visual.columnsDesc':
      'Choose visible columns and their order; drag a header divider to resize',
    'visual.columnsReset': 'Restore list defaults',
    'visual.columnsResetHint': 'Affects the list view only, never the saved connections',
    'visual.resetOrder': 'Reset order',
    'visual.resetWidths': 'Reset widths',
    'visual.columnsHint':
      'Double-click a header divider to restore all widths; hidden columns keep their position',
    'visual.columnWidthValue': 'Current width {width} px',
    'visual.moveColumnUp': 'Move column "{column}" up',
    'visual.moveColumnDown': 'Move column "{column}" down',
    'visual.resizeColumn': 'Resize column "{column}"',
    'visual.resizeColumnHint':
      'Drag to resize column "{column}", double-click to reset, arrow keys to fine-tune',

    'visual.shortcutNew': 'Ctrl N',
    'visual.shortcutSearch': 'Ctrl F',
    'list.tableLabel': 'Host list',
    'list.rowNumber': 'Row number',
    'visual.loadingHosts': 'Loading hosts',

    'visual.duplicate': 'Duplicate connection',
    'visual.duplicateDone': 'Connection duplicated',
    'visual.duplicateDoneDesc': 'Copy: {name} (saved password not copied)',
    'visual.duplicateFailed': 'Could not duplicate connection'
  }
}
