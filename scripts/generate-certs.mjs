import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function run(binary, args, cwd) {
  return spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function probeOpenSsl(binary) {
  const result = run(binary, ['version']);
  return !result.error && result.status === 0 && result.stdout.startsWith('OpenSSL ');
}

function resolveOpenSslBinary() {
  const configured = process.env.OPENSSL_BIN?.trim();
  if (configured) {
    if (!probeOpenSsl(configured)) throw new Error(`OPENSSL_BIN 无法执行 OpenSSL：${configured}`);
    return configured;
  }
  if (probeOpenSsl('openssl')) return 'openssl';

  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'openssl.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
  ].filter(Boolean);
  if (process.platform === 'win32') {
    const whereGit = run('where.exe', ['git.exe']);
    if (!whereGit.error && whereGit.status === 0) {
      for (const gitPath of whereGit.stdout.split(/\r?\n/).filter(Boolean)) {
        candidates.push(resolve(dirname(gitPath), '..', 'usr', 'bin', 'openssl.exe'));
      }
    }
  }
  const detected = candidates.find((candidate) => existsSync(candidate) && probeOpenSsl(candidate));
  if (detected) return detected;
  throw new Error('未找到 OpenSSL。请安装 Git for Windows/OpenSSL，或将 openssl.exe 完整路径写入环境变量 OPENSSL_BIN。');
}

function openssl(binary, args, cwd) {
  const result = run(binary, args, cwd);
  if (result.error) throw new Error(`OpenSSL 无法启动：${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `退出码 ${result.status}`;
    throw new Error(`openssl ${args[0]} 失败：${detail}`);
  }
}

export async function generateCertificates(outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const binary = resolveOpenSslBinary();
  console.log(`使用 OpenSSL：${binary}`);
  const work = await mkdtemp(join(tmpdir(), 'majo-certs-'));
  try {
    await writeFile(join(work, 'ca.cnf'), [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=v3_ca',
      'prompt=no',
      '[dn]',
      'CN=Majo Wolf Private CA',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid:always',
      '',
    ].join('\n'));
    await writeFile(join(work, 'server.ext'), [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:proxy.internal,IP:127.0.0.1',
      '',
    ].join('\n'));
    await writeFile(join(work, 'client.ext'), [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=clientAuth',
      '',
    ].join('\n'));

    openssl(binary, ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', join(output, 'ca.key')], work);
    openssl(binary, ['req', '-x509', '-new', '-sha256', '-key', join(output, 'ca.key'), '-out', join(output, 'ca.crt'), '-days', '3650', '-config', join(work, 'ca.cnf')], work);
    openssl(binary, ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', join(output, 'proxy-server.key')], work);
    openssl(binary, ['req', '-new', '-key', join(output, 'proxy-server.key'), '-out', join(work, 'proxy-server.csr'), '-subj', '/CN=proxy.internal'], work);
    openssl(binary, ['x509', '-req', '-sha256', '-in', join(work, 'proxy-server.csr'), '-CA', join(output, 'ca.crt'), '-CAkey', join(output, 'ca.key'), '-CAcreateserial', '-out', join(output, 'proxy-server.crt'), '-days', '825', '-extfile', join(work, 'server.ext')], work);
    openssl(binary, ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', join(output, 'main-client.key')], work);
    openssl(binary, ['req', '-new', '-key', join(output, 'main-client.key'), '-out', join(work, 'main-client.csr'), '-subj', '/CN=majo-main'], work);
    openssl(binary, ['x509', '-req', '-sha256', '-in', join(work, 'main-client.csr'), '-CA', join(output, 'ca.crt'), '-CAkey', join(output, 'ca.key'), '-CAcreateserial', '-out', join(output, 'main-client.crt'), '-days', '825', '-extfile', join(work, 'client.ext')], work);
    openssl(binary, ['verify', '-CAfile', join(output, 'ca.crt'), join(output, 'proxy-server.crt'), join(output, 'main-client.crt')], work);
    console.log(`证书已生成并验证：${output}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  generateCertificates(process.argv[2] ?? 'certs').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
