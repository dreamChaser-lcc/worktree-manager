import fs from 'node:fs';
import path from 'node:path';

function probe(labelText, runner) {
  try {
    console.log('  ' + labelText, '=>', runner());
  } catch (probeError) {
    console.log('  ' + labelText, '=> ERROR', probeError.code, probeError.message);
  }
}

for (const linkPath of ['D:\\symlink-test', 'D:\\junction-test']) {
  console.log(`\n=== ${linkPath} ===`);
  probe('existsSync', () => fs.existsSync(linkPath));
  probe('lstat.isSymbolicLink', () => fs.lstatSync(linkPath).isSymbolicLink());
  probe('readlink', () => fs.readlinkSync(linkPath));
  probe('readdir 条数', () => fs.readdirSync(linkPath).length);
  probe('读 vue/package.json 版本', () => {
    const packageText = fs.readFileSync(path.join(linkPath, 'vue', 'package.json'), 'utf8');
    return JSON.parse(packageText).version;
  });
  probe('读 .bin 目录', () => {
    try {
      return fs.readdirSync(path.join(linkPath, '.bin')).length + ' 项';
    } catch (binError) {
      return '不可读(' + binError.code + ')';
    }
  });
}
