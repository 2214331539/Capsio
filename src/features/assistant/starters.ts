import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';

/** Three ways to begin, for the page the assistant opens over. */
export function startersFor(
  context: Pick<WorkContext, 'workspace' | 'paperPath'>,
  personal: boolean,
): string[] {
  if (personal)
    return [t('帮我列一份这周的研究计划'), t('解释一个看不懂的概念'), t('把一段中文改成学术英文')];
  switch (context.workspace) {
    case 'literature':
      return context.paperPath
        ? [t('总结这篇论文'), t('找这篇论文的相关工作'), t('解释这篇论文用的方法')]
        : [t('按主题整理文献库里的论文'), t('推荐这个方向近两年的论文'), t('比较两篇论文的方法')];
    case 'notes':
      return [
        t('把最近的文档整理成一页周报'),
        t('列出文档里还没解决的问题'),
        t('根据文献写一份综述提纲'),
      ];
    case 'experiments':
    case 'files':
      return [
        t('讲讲这个实验的代码结构'),
        t('跑一次实验并汇报结果'),
        t('找出训练脚本里可能的问题'),
      ];
    case 'writing':
      return [t('检查这一节的语言和表达'), t('根据文献补一段相关工作'), t('修复 LaTeX 编译错误')];
    case 'remote':
      return [
        t('解释一段服务器报错日志'),
        t('写一个在服务器上跑实验的脚本'),
        t('把训练命令改成后台运行'),
      ];
    default:
      return [t('帮我规划这个课题的下一步'), t('总结项目里已有的材料'), t('解释一个看不懂的概念')];
  }
}
