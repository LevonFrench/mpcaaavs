"""Build an evidence-separated private disc report from receipts and files."""
import argparse
import collections
import json
import subprocess
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for n in ('manifest','out','scratch','repo'):ap.add_argument('--'+n,required=True,type=Path)
    ap.add_argument('--actors-out',type=Path)
    a=ap.parse_args();jobs=json.loads(a.manifest.read_text());rows=[];totals=collections.Counter();formats=collections.Counter();statuses=collections.Counter()
    for job in jobs:
        dest=a.out/'disc'/job['system']/job['slug'];meta=dest/'meta.json'
        m=json.loads(meta.read_text()) if meta.exists() else {'status':'pending','notes':['No finished scan receipt']}
        counts={f.name:len(list(f.rglob('*.png'))) for f in (dest/'raw').iterdir() if f.is_dir()} if (dest/'raw').exists() else {}
        ui=len(list((dest/'ui-candidates').rglob('*.png')));rooms=counts.get('rooms',0)
        notes=list(m.get('notes',[]));failurecounts=collections.Counter()
        if not counts and m['status']=='partial':
            notes.append('Readable filesystem; no supported image containers decoded. Packed/proprietary data remains unextracted.')
        for scan in (dest/'raw').glob('*scan.json'):
            try:
                for fail in json.loads(scan.read_text()).get('failures',[]):failurecounts[fail['reason']]+=1
            except (ValueError,KeyError):pass
        if failurecounts:notes.append('Decoder/file failures: '+'; '.join(f'{n} x {r}' for r,n in failurecounts.most_common(6)))
        if (dest/'raw'/'sotn-extraction.json').exists():
            so=json.loads((dest/'raw'/'sotn-extraction.json').read_text());notes.extend(so['notes']);notes.append(str(so['decoded'])+' explicitly palette-bound graphics')
        totals[job['system']]+=sum(counts.values());formats.update(counts);statuses[m['status']]+=1
        rows.append((job,dest,m,counts,ui,rooms,notes))
    disk=sum(p.stat().st_size for p in (a.out/'disc').rglob('*') if p.is_file())
    actor_summary=None
    if a.actors_out and (a.actors_out/'actor-audit.json').exists():
        actor_audit=json.loads((a.actors_out/'actor-audit.json').read_text());actor_meta=json.loads((a.actors_out/'meta.json').read_text())
        actor_summary={'path':str(a.actors_out.resolve()),'clips':len(actor_audit['clips']),'frames':actor_audit['total_frames'],'disk_bytes':sum(p.stat().st_size for p in a.actors_out.rglob('*') if p.is_file()),'validated_verbs':actor_meta.get('visual_accepted',[]),'sampled_enemies':actor_meta.get('sampled_assembled_enemies',[]),'sampled_bosses':actor_meta.get('sampled_assembled_bosses',[]),'stage_rom_timing_verified':actor_audit.get('stage_rom_timing_verified',0),'stage_rom_timing_mismatches':actor_audit.get('stage_rom_timing_mismatches',[]),'full_acceptance':False}
        reference_audit=a.actors_out/'animation-reference-audit.json'
        if reference_audit.exists():
            ra=json.loads(reference_audit.read_text());actor_summary['reference_verified_entries']=ra['verified_output_entries'];actor_summary['reference_unknown_offsets']=len(ra['unknown_offsets']);actor_summary['reference_mismatches']=len(ra['mismatches'])
    scratch=list(a.scratch.rglob('*')) if a.scratch.exists() else []
    scratchfiles=[p for p in scratch if p.is_file()]
    validationfile=a.out/'disc'/'VALIDATION.json'
    validation=json.loads(validationfile.read_text()) if validationfile.exists() else {}
    text=['# Private disc extraction report','', 'Counts describe extracted files, including palette variants, coverage masks and alternate atlas presentations; they are not counts of distinct assets. UI selection is heuristic. Game-specific sprite/animation acceptance is separate from a filesystem scan.', '',f'Manifest: {a.manifest.resolve()}',f'Jobs: {len(jobs)}. Statuses: {dict(statuses)}.',f'Raw PNGs: {sum(totals.values()):,}. UI candidates: {sum(r[4] for r in rows):,}. Formats: {dict(formats)}.',f'Disc output including catalogs: {disk:,} bytes ({disk/1024**3:.3f} GiB).',f'Scratch files: {len(scratchfiles)}; bytes: {sum(p.stat().st_size for p in scratchfiles):,}.','', '## Decoder validation','']
    for fmt in ('tim','pvr','gim','tim2','tpl','nitro','nitro-cells','nds-texture','nds-cpac','nds-strips','nds-structured','nds-palette-bank','rle','rooms','inventory','maps','sector-indexed','rgb555','huffman','udf','wad'):
        v=validation.get(fmt,{})
        text.append(f'- {fmt}: '+(v.get('result','No known-good sample visually validated; acceptance remains unmet.')))
        if v.get('sample'):text.append(f'  Sample: {v["sample"]}')
    if actor_summary:
        text.extend(['','## Supplemental actor extraction','',f'Output: {actor_summary["path"]}',f'Combined source-duration clips: {actor_summary["clips"]}; actor PNG timing entries: {actor_summary["frames"]:,}. Actor output including contact sheets and separate assembled poses: {actor_summary["disk_bytes"]:,} bytes.',f'Visually checked Alucard verbs: {", ".join(actor_summary["validated_verbs"])}. Other hero clips are indexed by source animation ID; structural checks do not establish their visual acceptance.',f'Sampled assembled enemies: {", ".join(actor_summary["sampled_enemies"])}. Sampled bosses: {", ".join(actor_summary["sampled_bosses"])}.',f'Stage timing entries checked directly against disc bytes: {actor_summary["stage_rom_timing_verified"]}; mismatches: {len(actor_summary["stage_rom_timing_mismatches"])}. Contact sheets are sampled checks, not complete coverage of every clip or runtime effect.','Animation table calls, loops, jumps and end/hold markers are recorded. Source sprite offsets and pivots align each clip on a fixed canvas. Base disc palette is used; runtime equipment/cloak customization is not applied.',''])
        if 'reference_verified_entries' in actor_summary:
            text.append(f'Reference C macro literals matched {actor_summary["reference_verified_entries"]:,} exported timing entries, with {actor_summary["reference_mismatches"]} mismatches and {actor_summary["reference_unknown_offsets"]} offsets outside the parsed reference data. Downloaded source was read as data, never executed.')
    text.extend(['','## Coverage limits','', '- SOTN every-entity assembly, weapon layers, runtime component effects, and complete impact markers remain incomplete. Four required Alucard verbs, ten arena enemies and two bosses have sampled visual evidence. Hunting Girl exports sword only; Plate Lord has an unsupported palette, and neither counts toward ten-enemy acceptance.', '- NCER/NANR static cells and index/translation animation tables are implemented and sampled on three native reference sets. Affine/mosaic/blended OBJ, NCER VRAM transfers and nonidentity SRT rendering remain unsupported. Native source frame order, durations and play-mode metadata are preserved. Proprietary PS2 compression, palette-indexed PVR/PVP, GTX, RVZ, and encrypted Wii content remain unsupported. No keys were searched.', '- UDF type-1 physical partitions and PS2 full-uint32 single-extent lengths are implemented. Four native discs match ISO9660 trees after case/trailing-dot normalization and 243 source-byte samples match; compressed CSO fallback is included. Synthetic multipart, declared-hole, inline, continuation, extended-entry and Unicode tests pass. Type-2/VAT/sparing/metadata partitions, extended allocation descriptors and indirect ICBs remain unsupported. No new image coverage from this reader validation.', '- Native structured DS output includes 2015 1bpp font masks, 306 proper portrait masks and 7513 source-paletted tile-bank atlases. All font masks reencode exactly to native payload bytes; all five font atlases and 18 portraits inspected. Representative banks show UI glyphs/captions and sprite/effect parts; some dense/sparse banks remain visually ambiguous. Atlas width is a presentation choice, not native screen geometry. Full OAM/screen assembly and runtime colour/alpha binding remain incomplete. Face bank atlases overlap proper portraits, so artifact counts are not distinct asset counts. Corrected payload-based LZ10 detection preserved every prior PNG and added 278 Zero Collection banks; prior receipts retained.', '- Nintendo Huffman byte/nibble decompression passes documented structural examples; none of the requested DS file-start candidates decoded successfully. This establishes no new native image coverage.', '- WiiWare WAD header and content table parsed successfully: five encrypted contents. Ticket/certificate bytes skipped; encrypted payloads remain skipped without keys.', '- All twelve requested DS games have readable NitroFS trees. Phoenix Wright now has 2131 source-header textures, 450 mapped RL frames and 273 source-paletted strip images. Apollo Justice has 1860 CPAC textures. Justice for All now has 159 and Trials and Tribulations 187 native strip images. These four games have sampled visual evidence and private provenance. ZX now has 3181 PNGs, ZX Advent 3346 and Zero Collection 3307; their fonts/portraits and source-paletted canonical atlases have sampled checks. Five other requested DS titles still lack supported image output. Native strip tables provide palette/extent bindings; 619 archives have one matching documented layout, and 59 ambiguous widths/heights stay unrendered. Regional filemap offsets and semantic names are not reused. Apollo palette-only associations and 2300 unrecognized CPAC members remain incomplete. Indexed runtime transparency and full character assembly remain unbound. Nitro NCER/NANR validation uses a separate owner-provided sample.', '- PS1 Dino Crisis has 204 native item-bank pages, ten indexed atlases/variants and four linear RGB555 screens. Dino Crisis 2 has 128 item pages, 48 file images, 64 indexed atlases/variants (including 33 map variants) and eighteen RGB555 screens. Sampled costume portraits, status fonts, menu labels, memory-card panels, options and native backgrounds are coherent. The Dino2 title banks use 4bpp source palettes and include sharp and blurred label variants; runtime effect purpose is unverified. Complete named UI coverage and assembled runtime screens remain incomplete. Unbound palette and crop probes remain isolated under decoder validation.', '- Resident Evil Survivor has TIM images but no decoded room backgrounds. The requested Survivor room acceptance remains unmet.', '- Legacy PIX/RAW guesses remain unverified. Mapped RE1/RE2/RE3 native inventories use exact source records and source TIM palettes with sampled visual acceptance. Complete named status/map/file/item UI coverage for all required games remains incomplete.', '- Files with no recognized containers are not evidence of complete extraction. Raw bitmap guesses remain unverified and are isolated from confirmed formats.', '- No emulator/game playback, program downloads, ROM writes, commits, pushes, or public asset copies were performed by this job.',''])
    for system in dict.fromkeys(j['system'] for j in jobs):
        text.extend([f'## {system}','', '| Game | Status | Raw formats/counts | UI | Rooms |', '|---|---|---|---:|---:|'])
        for job,dest,m,counts,ui,rooms,notes in rows:
            if job['system']!=system:continue
            text.append(f'| {job["slug"]} | {m["status"]} | '+', '.join(f'{f}: {n}' for f,n in counts.items())+f' | {ui} | {rooms} |')
        for job,dest,m,counts,ui,rooms,notes in rows:
            if job['system']!=system:continue
            text.extend(['',f'### {job["slug"]}',f'Output: {dest.resolve()}', 'Sources: '+'; '.join(job.get('sources',[]))])
            text.extend('- '+note.replace('\n',' ') for note in notes)
            if sum(counts.values())<50:
                tree=dest/'files.txt';largest=[]
                for line in tree.read_text(errors='replace').splitlines() if tree.exists() else []:
                    fields=line.split('\t')
                    if len(fields)>=2:
                        try:largest.append((int(fields[1]),fields[0]))
                        except ValueError:pass
                if largest:
                    text.extend(['','Largest filesystem files for follow-up:', '', '| Disc path | Bytes |', '|---|---:|'])
                    text.extend(f'| {name.replace("|", "&#124;")} | {size:,} |' for size,name in sorted(largest,reverse=True)[:10])
    r=subprocess.run(['git','-c','core.excludesFile=','-C',str(a.repo),'status','--short','--ignore-submodules=all'],capture_output=True,text=True)
    text.extend(['','## Repository state','', 'The checkout already contained unrelated untracked files when this job began. They were preserved. Only new generic extractor scripts were added by this job; private outputs are ignored.', '', '```text',r.stdout.rstrip(),'```'])
    if r.returncode:text.extend(['Git status error: '+r.stderr.strip()])
    (a.out/'disc'/'REPORT.md').write_text('\n'.join(text)+'\n',encoding='utf-8')
    (a.out/'disc'/'REPORT.json').write_text(json.dumps({'jobs':len(jobs),'statuses':dict(statuses),'raw_count':sum(totals.values()),'ui_candidate_count':sum(r[4] for r in rows),'formats':dict(formats),'disk_bytes':disk,'scratch_files':len(scratchfiles),'actor_extraction':actor_summary,'full_acceptance':False},indent=2))
    print(json.dumps({'jobs':len(jobs),'statuses':dict(statuses),'raw':sum(totals.values()),'ui':sum(r[4] for r in rows),'formats':dict(formats),'disk_bytes':disk,'scratch_files':len(scratchfiles)}))

if __name__=='__main__':main()
