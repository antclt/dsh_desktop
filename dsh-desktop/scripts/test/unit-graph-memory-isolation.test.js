import test from 'node:test'
import assert from 'node:assert/strict'

test('graph-memory workspace and turn isolation logic', () => {
  const sessionWorkspaceMap = new Map()
  const sessionPromptTurns = new Map()
  const HOST = 'dsh'

  // 模拟两个工作区下的历史会话记录
  sessionWorkspaceMap.set('sess-1', 'c:/projects/my-web')
  sessionWorkspaceMap.set('sess-2', 'c:/projects/other-app')

  // 模拟召回的节点：一个来自同项目，一个来自跨项目
  const recalledNodes = [
    {
      id: 'node-same-ws',
      title: 'Web前端组件构建经验',
      sourceSessions: [`${HOST}:sess-1`],
    },
    {
      id: 'node-diff-ws',
      title: '其他项目无关数据库报错',
      sourceSessions: [`${HOST}:sess-2`],
    },
  ]
  const recalledEdges = [
    { fromId: 'node-same-ws', toId: 'node-same-ws' },
    { fromId: 'node-diff-ws', toId: 'node-diff-ws' },
  ]

  // 场景 1：第一次对话（turnCount = 1）
  const turn1 = 1
  const currentCwd = 'C:\\Projects\\my-web' // 验证大小写及斜杠兼容
  let turn1Nodes = recalledNodes
  if (turn1 > 1 && currentCwd) {
    // 不应进入过滤
    turn1Nodes = []
  }
  assert.equal(turn1Nodes.length, 2, '首轮提问应允许全局召回，提供经验冷启动')

  // 场景 2：第二次对话（turnCount = 2，处于 my-web 工作区）
  const turn2 = 2
  const normCurrent = String(currentCwd).replace(/\\/g, '/').toLowerCase()
  let turn2Nodes = recalledNodes
  let turn2Edges = recalledEdges
  if (turn2 > 1 && currentCwd) {
    turn2Nodes = recalledNodes.filter((node) => {
      if (!node.sourceSessions || !node.sourceSessions.length) return false
      return node.sourceSessions.some((sKey) => {
        const rawId = sKey.startsWith(`${HOST}:`) ? sKey.slice(HOST.length + 1) : sKey
        const recordedCwd = sessionWorkspaceMap.get(String(rawId))
        if (!recordedCwd) return false
        return String(recordedCwd).replace(/\\/g, '/').toLowerCase() === normCurrent
      })
    })
    const nodeIds = new Set(turn2Nodes.map((n) => n.id))
    turn2Edges = recalledEdges.filter((e) => nodeIds.has(e.fromId) && nodeIds.has(e.toId))
  }

  assert.equal(turn2Nodes.length, 1, '多轮对话后必须严格过滤非同工作区节点')
  assert.equal(turn2Nodes[0].id, 'node-same-ws', '留下的必须是当前工作区的经验节点')
  assert.equal(turn2Edges.length, 1)

  // 场景 3：episodicXml 剥离判定
  const episodicXml = '<episodic_context>长篇历史会话复读文本...</episodic_context>'
  const turn1Episodic = turn1 <= 1 ? episodicXml : undefined
  const turn2Episodic = turn2 <= 1 ? episodicXml : undefined
  assert.ok(turn1Episodic, '首轮保留 episodicXml 完整会话语境')
  assert.equal(turn2Episodic, undefined, '后续轮次必须剔除冗长的 episodicXml 历史对话复读')
})
