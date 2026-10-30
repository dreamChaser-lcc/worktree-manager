/**
 * 使用指南内容数据源：纯数据，与弹窗视图解耦，便于单独维护文案。
 * 结构：section（左侧目录项）→ block（正文块），block.type 决定在 HelpGuideDialog 中的渲染方式。
 * block.type 取值：paragraph / list / command / warning / table
 * 编排原则：以「需求任务」流程为主线（第 1-6 章），其余为支撑性功能（第 7 章起）。
 */
export const helpGuideSections = [
  {
    id: 'requirement-overview',
    title: '1. 需求任务全流程',
    blocks: [
      {
        type: 'paragraph',
        text: '本工具的核心是「需求任务」：拿到一个需求后，以需求为维度把涉及的多个项目、各自的开发分支与 worktree 聚合在一个任务里，从创建、安装依赖、日常开发到完成归档一站式管理。推荐按以下流程使用：'
      },
      {
        type: 'list',
        items: [
          '第一步：新建需求任务 —— 粘贴需求链接与标题、填写开发分支、添加涉及项目',
          '第二步：为项目创建 worktree —— 表单内一键创建（路径自动按需求目录预填），或关联已有 worktree',
          '第三步：保存 —— 默认自动生成 .code-workspace 工作区文件，聚合各项目已关联的 worktree',
          '第四步：打开工作区开始开发 —— 多项目一个窗口；依赖有风险就执行「独立安装」',
          '第五步：日常开发 —— 随时查看各项目分支位置、与需求分支是否一致',
          '第六步：需求完成 —— 删除需求任务（worktree 与目录一并清理，git 分支保留，可随时恢复）'
        ]
      },
      {
        type: 'paragraph',
        text: '下面按步骤展开。「创建 Worktree」「Worktree 管理」「设置」等独立页面在第 7 章之后说明。'
      }
    ]
  },
  {
    id: 'requirement-create',
    title: '2. 第一步：新建需求任务',
    blocks: [
      {
        type: 'paragraph',
        text: '在「需求任务」页（默认页签）点击「新建需求任务」，在弹出的表单中填写：'
      },
      {
        type: 'table',
        columns: ['字段', '填写说明'],
        rows: [
          ['需求名称', '如【小蛋】直播任务支持区分不同路径玩法；它同时决定需求聚合目录名与工作区文件名（自动做文件名安全化）'],
          ['需求链接', '粘贴 TAPD 等需求地址；支持整段粘贴「标题 + 链接」—— 会自动拆分，标题填入需求名称、地址填入本字段'],
          ['分支名称', '该需求对应的开发分支（如 feature/xxx）；填写后，各项目主仓库下与此分支同名的 worktree 会自动预选'],
          ['涉及项目', '至少一个。选择主仓库路径后项目名称自动取目录最后一段（D:\\project\\admin-web → admin-web），可修改'],
          ['备注（预留）', '可选。记录需求背景、联调约定等']
        ]
      },
      {
        type: 'paragraph',
        text: '每个项目行包含：项目名称、主仓库路径（带目录浏览）、关联 worktree 下拉。下拉选项来自该主仓库的真实 worktree 清单（标注 [主目录] 与各自分支），与需求分支同名的会自动预选；也可以先不关联，稍后在表单内直接创建。'
      },
      {
        type: 'list',
        items: [
          '「添加项目」可增行（一个需求常涉及前后端多个项目），多于一行的项目卡右上角有「移除项目」',
          '勾选「保存后生成工作区文件」（默认勾选）时，保存后会在工作区文件目录生成 .code-workspace，聚合各项目已关联的 worktree',
          '保存校验：需求链接、分支名称、每个项目的名称与主仓库路径必填'
        ]
      }
    ]
  },
  {
    id: 'requirement-worktree',
    title: '3. 第二步：为项目创建 worktree',
    blocks: [
      {
        type: 'paragraph',
        text: '项目行内点击「创建 worktree」打开快捷创建弹层（需先选择主仓库路径）。这是最常用的入口 —— 创建成功后自动回填到该项目的「关联 worktree」：'
      },
      {
        type: 'table',
        columns: ['配置项', '说明'],
        rows: [
          ['新 worktree 路径', '已自动按 <需求聚合目录>\\<项目名> 预填完整路径（目录在点击创建时才生成），可修改或点浏览调整'],
          ['分支', '默认「新建分支」，基于远程最新分支（origin/HEAD → origin/master|main）自动填好基准；也可改选已有分支（被占用的分支会标注）'],
          ['依赖处理', '三选一，见下方说明；按主仓库 lockfile 自动推荐并标注「推荐」，可手动覆盖'],
          ['创建后动作', '可选「复制被忽略文件」—— 把 .env、.env.local、*.local 白名单文件从主仓库复制过来（默认勾选）']
        ]
      },
      {
        type: 'paragraph',
        text: '需求聚合目录默认位于工作区文件目录下、以需求名称命名（如 D:\\softwares\\worktree-manager\\workspaces\\【小蛋】直播任务…\\CustomerServiceSystem），一个需求的项目目录聚在一起，便于统一清理。该聚合行为可在设置页关闭（关闭后 worktree 不再按需求归组）。'
      },
      {
        type: 'table',
        columns: ['依赖策略', '适用与说明'],
        rows: [
          ['共享主目录（junction）', '秒级完成、零额外磁盘；依赖版本以主目录为准，npm / yarn 项目推荐'],
          ['独立安装', '依赖完全隔离；pnpm 走全局 store 硬链接，磁盘占用近似为零；后台任务执行，日志实时可查'],
          ['不处理', '只创建目录，依赖稍后自行安装']
        ]
      },
      {
        type: 'paragraph',
        text: '点击创建前会做五道前置校验，任一不通过都会给出明确原因：主仓库是有效 git 仓库、目标路径可用、不与已有 worktree 嵌套、目标分支未被其他 worktree 签出、分支名合法。'
      },
      {
        type: 'warning',
        text: '共享模式下请勿在 worktree 内执行 npm / pnpm / yarn install —— 会写穿目录联接、改写主目录依赖，波及所有共享它的 worktree。需要独立依赖时，用第 4 章的「独立安装」。'
      },
      {
        type: 'warning',
        text: 'Windows 下目录联接要求同一磁盘卷；跨卷请选择「独立安装」或「不处理」。'
      }
    ]
  },
  {
    id: 'requirement-install',
    title: '4. 第三步：依赖安装与风险处理',
    blocks: [
      {
        type: 'paragraph',
        text: '保存需求任务后展开明细（列表点「查看」），每个项目卡片有「依赖」一行，实时展示该 worktree 的依赖状态：'
      },
      {
        type: 'table',
        columns: ['状态', '含义与处理'],
        rows: [
          ['共享主目录', 'node_modules 与主仓库联接共享；主仓库依赖变更会同步影响本 worktree'],
          ['独立安装', 'node_modules 为真实目录，依赖隔离；可随时「恢复共享」切回联接'],
          ['未安装', '尚未安装依赖'],
          ['高风险', '共享模式下主目录依赖与 lockfile 声明不一致，存在写穿与版本漂移风险，强烈建议执行「独立安装」']
        ]
      },
      {
        type: 'paragraph',
        text: '点「独立安装」会弹出选项弹窗：'
      },
      {
        type: 'list',
        items: [
          '默认安装：自动检测包管理器（worktree lockfile → 主仓库 lockfile → npm 兜底），执行 <包管理器> install；若是共享链接会先只断开链接本身（不删主目录内容）再安装',
          '自定义安装脚本（可选）：在输入框填整段脚本（如 pnpm install --frozen-lockfile，支持多行），将以 shell 在该 worktree 目录下执行，完全替换默认命令；留空即默认安装',
          '安装是后台任务：同 worktree 同时只允许一个安装任务，重复触发会被拒绝（提示 409）；执行中也不能「恢复共享」',
          '启动后项目卡片下方出现日志面板，实时滚动输出；也可在「任务记录」中回看（含完整历史日志）'
        ]
      },
      {
        type: 'paragraph',
        text: '安装完成后「恢复共享」会把独立安装的 node_modules 删除并重建与主仓库的联接。切回共享前请确认主目录依赖完好。'
      }
    ]
  },
  {
    id: 'requirement-daily',
    title: '5. 日常开发：明细查看与分支定位',
    blocks: [
      {
        type: 'paragraph',
        text: '需求列表点「查看」展开明细，包含工作区文件、项目卡片、项目名称与 git 链接、备注：'
      },
      {
        type: 'list',
        items: [
          '工作区文件：展示生成路径，可「打开工作区」（编辑器打开多项目窗口）、「显示」（资源管理器定位）、「重新生成」；未生成时可点击重新生成补建',
          '分支位置：展示关联 worktree 当前实际所在分支，并标注「与需求一致」或「非需求分支」「有未提交修改」；项目未关联 worktree 时回退显示主仓库当前分支；需求分支若签出在别处也会提示位置',
          '打开 / 显示：直接用编辑器打开 worktree 目录，或在资源管理器中定位（编辑器命令可在设置页配置）',
          '涉及项目名称：每个项目附带其 git 远程地址的可点击网页链接（自动从 git@host:group/repo 等形式转换）',
          '分支冲突提示：同一项目主仓库被多个需求关联了相同分支时，卡片会标「分支冲突」—— 同一分支只能签出在一个 worktree，请核对'
        ]
      },
      {
        type: 'paragraph',
        text: '页面下方的「任务记录」汇总所有后台任务（依赖安装等）：任务名、状态（执行中 / 成功 / 失败 / 已中断）、起止时间；点「查看日志」看完整输出。「已中断」表示上次服务运行中进程被终止，重启后可在此追溯。'
      }
    ]
  },
  {
    id: 'requirement-archive',
    title: '6. 需求完成：删除与恢复',
    blocks: [
      {
        type: 'paragraph',
        text: '需求结束后点「删除」，会先弹确认框列出将要做的事：'
      },
      {
        type: 'list',
        items: [
          '移除该需求关联的全部 worktree，并一并删除 worktree 的文件目录（释放磁盘）',
          'git 分支不受影响：本地与远程分支均保留；删除前会记录每个 worktree 当时的实际分支',
          '删除工作区文件（生成物）；需求目录若已空则一并移除；记录进入「已删除」状态（软删除）'
        ]
      },
      {
        type: 'paragraph',
        text: '删除后该行显示「已删除」并提供「恢复」按钮：按删除前记录的主仓库 / 路径 / 实际分支重建全部 worktree（目录会重新生成）并重新生成工作区文件；已手工重建过的会跳过（幂等）。'
      },
      {
        type: 'warning',
        text: '「彻底删除」会物理删除任务记录本身（不可恢复），worktree 与目录一并移除，但 git 分支仍然保留；如需连分支一起清理请用 git 命令自行处理。'
      },
      {
        type: 'paragraph',
        text: '若个别 worktree 删除失败（如存在未提交修改被拦截），本次删除会整体中止并保留现场，失败原因会逐项目列出。'
      }
    ]
  },
  {
    id: 'standalone-create',
    title: '7. 独立创建 Worktree 页',
    blocks: [
      {
        type: 'paragraph',
        text: '不走需求流程、只是临时开一个并行开发目录时，用「创建 Worktree」页：'
      },
      {
        type: 'list',
        items: [
          '页面打开自动回填上次使用的主仓库，「最近主仓库」下拉可一键切换（保留最近 10 条）',
          '四步操作：选主仓库 → 选/新建分支 → 选目标路径 → 选依赖策略；目录选择器默认定位到「代码默认存储目录」（默认 D:\\project）',
          '同样的五道前置校验与三种依赖策略；创建后动作（复制被忽略文件、编辑器打开）同样可用',
          '创建历史在「Worktree 管理」页下方，成功与失败均留痕并记录原因'
        ]
      }
    ]
  },
  {
    id: 'manage',
    title: '8. Worktree 管理页',
    blocks: [
      {
        type: 'list',
        items: [
          '列表展示当前主仓库全部 worktree：路径、分支、HEAD、脏状态（有未提交修改会标注）、主 worktree 标识',
          '删除有三道拦截：存在未提交修改需强制确认、提示未合并提交数、主 worktree 禁止删除',
          'prune：清理目录已不存在的失效 worktree 记录',
          '打开：用编辑器打开该目录'
        ]
      }
    ]
  },
  {
    id: 'settings',
    title: '9. 设置页',
    blocks: [
      {
        type: 'table',
        columns: ['配置项', '说明'],
        rows: [
          ['数据根目录', '存放数据库与任务日志的位置，修改后立即生效；历史数据保留在原目录，不会自动迁移'],
          ['代码默认存储目录', '目录选择器的默认起始定位，默认 D:\\project'],
          ['工作区文件目录', '.code-workspace 的存放位置，默认为数据目录下的 workspaces\\；需求任务的聚合目录也基于它'],
          ['需求聚合目录模式', '开启时 worktree 按 <工作区目录>\\<需求名>\\<项目名> 归组；关闭后创建 worktree 不再按需求归组'],
          ['编辑器命令', '「打开」动作使用的命令，默认 code，可改成 cursor 等其他编辑器']
        ]
      }
    ]
  },
  {
    id: 'quick-start',
    title: '10. 启动与访问',
    blocks: [
      {
        type: 'paragraph',
        text: '环境要求：Node.js ≥ 18、Git。最简单的方式：双击项目根目录的 start.bat，自动安装依赖、构建前端、启动服务并打开浏览器。也可在终端手动执行：'
      },
      {
        type: 'command',
        lines: [
          'npm run setup             # 安装 server/ 与 web/ 依赖',
          'npm run build:web         # 构建前端产物',
          'npm start                 # 启动服务，访问 http://127.0.0.1:5210',
          'npm run dev               # 开发模式：后端热重启 + 前端自动打包（Ctrl+C 全部退出）'
        ]
      },
      {
        type: 'paragraph',
        text: '默认仅监听 127.0.0.1（仅本机可访问）。start.bat 已默认设置 WORKTREE_MANAGER_HOST=0.0.0.0 允许局域网访问；首次被局域网访问时 Windows 防火墙可能拦截，放行 5210 端口即可（管理员执行 netsh advfirewall firewall add rule name="Worktree Manager" dir=in action=allow protocol=TCP localport=5210）。所有数据存放在本机磁盘，不上传任何服务器。'
      }
    ]
  },
  {
    id: 'persistence',
    title: '11. 数据与持久化',
    blocks: [
      {
        type: 'list',
        items: [
          '数据根目录默认 D:\\softwares\\worktree-manager，D 盘不存在时自动回退到 %USERPROFILE%\\worktree-manager-data',
          '目录内容：nedb\\（任务元数据、创建历史、最近主仓库三个库）+ job-logs\\（每个安装任务一个 .jsonl 日志）',
          '配置文件固定在 %USERPROFILE%\\.worktree-manager\\settings.json，与数据目录分离；缺失或损坏会按默认规则重建，不影响业务数据',
          '服务重启后：历史任务与日志可回看、主仓库目录自动回填、需求任务与删除记录完整保留'
        ]
      },
      {
        type: 'warning',
        text: '请勿同时启动多个服务实例 —— 嵌入式数据库无跨进程锁，多实例会互相干扰。'
      }
    ]
  },
  {
    id: 'faq',
    title: '12. 常见问题',
    blocks: [
      {
        type: 'table',
        columns: ['现象', '原因与处理'],
        rows: [
          ['提示「分支已被其他 worktree 签出」', 'git 限制同一分支不能同时签出在两处；可能是其他需求已占用该分支（明细中会有分支冲突提示），请新建分支或选其他分支'],
          ['提示「已有安装任务执行中」', '同一 worktree 的安装任务互斥，等当前任务结束（任务记录中看状态）再触发；执行中也不能恢复共享'],
          ['共享模式运行时报依赖找不到', '主目录换了依赖版本或结构，回主目录重新安装即可，所有共享方同步生效；或对该项目执行独立安装'],
          ['杀毒软件提示 junction', '目录联接是 Windows 标准能力（等价于 mklink /J），无需管理员权限，加入白名单即可'],
          ['页面显示「服务未连接」', '后端未启动或端口被占用，重新执行 npm start 后刷新页面']
        ]
      }
    ]
  }
];
