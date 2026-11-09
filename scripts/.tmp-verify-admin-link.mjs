import fs from 'node:fs';
import path from 'node:path';

const linkPath = 'D:\\junction-test';

function probe(labelText, runner) {
  try {
    console.log('  ' + labelText, '=>', runner());
  } catch (probeError) {
    console.log('  ' + labelText, '=> ERROR', probeError.code, probeError.message);
  }
}

console.log('当前进程权限：普通（Medium 完整性）\n');
console.log('=== 管理员创建的 junction 能否被普通权限读取 ===');
probe('existsSync', () => fs.existsSync(linkPath));
probe('lstat.isSymbolicLink', () => fs.lstatSync(linkPath).isSymbolicLink());
probe('readlink', () => fs.readlinkSync(linkPath));
probe('readdir 条数', () => fs.readdirSync(linkPath).length);
probe('前 5 项', () => fs.readdirSync(linkPath).slice(0, 5).join(', '));
probe('读 vue/package.json 版本', () => {
  const packageText = fs.readFileSync(path.join(linkPath, 'vue', 'package.json'), 'utf8');
  return JSON.parse(packageText).version;
});
