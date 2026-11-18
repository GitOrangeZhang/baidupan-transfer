// 装箱算法：把目录项按递归文件数分批，每批 <= limit
// 规则：整目录不拆开（除非单项本身超过 limit，需要下钻），大项优先，首次适配

function packBatches(items, limit = 500) {
  const sorted = [...items].sort((a, b) => b.files - a.files);
  const batches = [];
  const needSplit = [];

  for (const it of sorted) {
    if (it.files > limit) { needSplit.push(it); continue; }
    let placed = false;
    for (const b of batches) {
      if (b.used + it.files <= limit) {
        b.items.push(it); b.used += it.files; placed = true; break;
      }
    }
    if (!placed) batches.push({ items: [it], used: it.files });
  }
  return { batches, needSplit };
}

module.exports = { packBatches };

if (require.main === module) {
  // 用法: node pack.js '<items JSON>' [--limit 400]
  // items JSON: [{"name":"目录名","type":"dir","files":123}, ...]
  let items = null;
  let limit = 500;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { limit = parseInt(args[++i], 10) || 500; }
    else { try { const p = JSON.parse(args[i]); if (Array.isArray(p)) items = p; } catch (e) { /* ignore */ } }
  }
  if (!items) {
    console.error("用法: node pack.js '<items JSON>' [--limit 400]");
    console.error("示例: node pack.js '[{\"name\":\"目录A\",\"type\":\"dir\",\"files\":120}]'");
    process.exit(1);
  }

  const total = items.reduce((a, b) => a + b.files, 0);
  const { batches, needSplit } = packBatches(items, limit);

  console.log(`总文件数: ${total}  上限: ${limit}  需要批数: ${batches.length}`);
  batches.forEach((b, i) => {
    console.log(`\n第 ${i + 1} 批  ${b.used} 个文件（余 ${limit - b.used}）`);
    b.items.forEach(it => console.log(`   + ${it.name}  (${it.files})`));
  });
  if (needSplit.length) {
    console.log('\n需继续下钻的项（自身 > 上限）:');
    needSplit.forEach(it => console.log(`   ! ${it.name} (${it.files})`));
  }
  // 机器可读输出
  console.log('\n__JSON__');
  console.log(JSON.stringify({ total, limit, batches: batches.map(b => ({ files: b.used, items: b.items.map(i2 => i2.name) })), needSplit: needSplit.map(i2 => ({ name: i2.name, files: i2.files })) }));
}