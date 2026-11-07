"""Vendor exact official Solidity sources, never the package JS runtime."""
import hashlib,json,pathlib,tarfile,urllib.request,io,shutil
root=pathlib.Path(__file__).resolve().parents[1]
commit='bf943f80fec5ac647159d26161446ac5d716a294'
url=f'https://codeload.github.com/safe-global/safe-smart-account/tar.gz/{commit}'
blob=urllib.request.urlopen(url,timeout=90).read()
archive=tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz')
out=root/'vendor/safe-1.4.1';out.mkdir(parents=True,exist_ok=True)
files={}
for member in archive.getmembers():
    rel=pathlib.PurePosixPath(*pathlib.PurePosixPath(member.name).parts[1:])
    if not member.isfile() or not (str(rel).startswith('contracts/') or str(rel) in ('LICENSE','README.md')):continue
    assert not rel.is_absolute() and '..' not in rel.parts
    data=archive.extractfile(member).read()
    installed=root/'node_modules/@safe-global/safe-contracts'/str(rel)
    if str(rel).startswith('contracts/'):
        assert installed.exists() and installed.read_bytes()==data, f'upstream mismatch {rel}'
    target=out/str(rel);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    files[str(rel)]=hashlib.sha256(data).hexdigest()
(out/'SOURCE.json').write_text(json.dumps({'upstream':url,'commit':commit,'tag':'v1.4.1','archive_sha256':hashlib.sha256(blob).hexdigest(),'npm_integrity':'sha512-fP1jewywSwsIniM04NsqPyVRFKPMAuirC3ftA/TA4X3Zc5EnwQp/UCJUU2PL/37/z/jMo8UUaJ+pnFNWmMU7dQ==','sha256':files,'review':'All vendored Solidity bytes compared against installed official npm 1.4.1; independent custody/advisory approval NOT established. No JS copied.'},indent=2))
print('Verified and vendored',len(files),'official files at immutable commit',commit)
