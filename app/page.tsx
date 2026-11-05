import Image from 'next/image';
import Link from 'next/link';

import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';

import { ThemeToggle } from './theme-toggle';
import { Brand } from './brand';
import { HomeButton } from './home-button';

/*
 * The landing page.
 *
 * The old home page was a build-step checklist for the developer. It still
 * exists, at /health — but the first thing a person sees should be the offer,
 * not the wiring.
 *
 * The page is laid out the way a chat assistant is: a mark at the top, a
 * greeting in the middle, and a rounded box to type into. Everything else is
 * below the fold, on a tinted band that keeps the page from being one long
 * sheet of colour.
 */

const STEPS = [
  {
    n: '1',
    title: 'อัปโหลดรูปห้อง',
    body: 'ถ่ายรูปห้องของคุณมาหนึ่งรูป ผมจะดูสไตล์ สี แสง และหาพื้นที่ว่างให้',
  },
  {
    n: '2',
    title: 'บอกสไตล์กับงบ',
    body: 'พิมพ์มาเลยว่าชอบอะไร งบเท่าไหร่ หรือกดชิปที่ให้ไว้ด้านล่าง ไม่ต้องกรอกฟอร์มให้ยาก',
  },
  {
    n: '3',
    title: 'ดูของวางจริงในห้อง',
    body: 'เลือกชิ้นที่ชอบแล้วกด "วางในห้องให้ดู" ผมจะเอาไปวางลงในรูปห้องของคุณให้',
  },
];

const PROMISES = [
  {
    title: 'รูปห้องไปแค่ 2 ที่',
    body: 'ให้โมเดลแชทอ่านห้อง และให้โมเดลวาดรูปวางเฟอร์นิเจอร์ ไม่มีการคัดลอกรูปไปยังที่อื่น',
  },
  {
    title: 'ตัดข้อมูล GPS ทิ้งก่อน',
    body: 'ข้อมูล EXIF รวมถึงตำแหน่งถูกลบตั้งแต่ตอนอัปโหลด ก่อนไฟล์จะถึงที่เก็บข้อมูลหรือโมเดลใด ๆ',
  },
  {
    title: 'เก็บในที่เก็บแบบส่วนตัว',
    body: 'ลิงก์ดูรูปมีอายุ 1 ชั่วโมง เข้าถึงได้เฉพาะเซสชันของคุณ และลบได้ทันทีทุกเมื่อ',
  },
  {
    title: 'ราคาและขนาดจริงเสมอ',
    body: 'ทุกตัวเลขมาจากฐานข้อมูล ไม่ใช่การเดาของโมเดล และวัดว่าวางได้ไหมด้วยกฎ ไม่ใช่ด้วยการเดา',
  },
];

/** The things the assistant can do, as pills under the greeting. */
const CAPABILITIES = [
  'แนะนำเฟอร์นิเจอร์',
  'เทียบราคาและขนาด',
  'เช็กว่าวางในห้องได้ไหม',
  'วาดรูปจำลองลงห้องของคุณ',
];

export default async function Home() {
  // Someone who is already signed in sees their history instead of the
  // sign-in link. The chat works either way — the account is for the log.
  const account = await resolveUserByToken(await readAuthToken());

  return (
    <main className="min-h-dvh bg-surface">
      {/* ---- top bar ---- */}
      <header className="flex items-center gap-2 bg-band px-5 py-4 text-band-ink sm:px-8">
        <HomeButton />
        <nav className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {account ? (
            <Link href="/history" className="btn-band px-4 py-2 text-sm text-band-ink-soft">
              ประวัติ
            </Link>
          ) : (
            <Link href="/login" className="btn-band px-4 py-2 text-sm text-band-ink-soft">
              เข้าสู่ระบบ
            </Link>
          )}
          <Link href="/chat" className="btn-band-primary px-4 py-2 text-sm">
            เริ่มแชท
          </Link>
        </nav>
      </header>

      {/* ---- hero ---- */}
      <section className="mx-auto max-w-3xl px-6 pt-8 pb-14 text-center sm:pt-14 sm:pb-20">
        {/* The mark, and the name under it. The words are live text so they
            follow the theme — the wordmark in the picture was navy, and navy
            disappears on the dark canvas. */}
        <Image
          src="/roomyai-icon.png"
          alt=""
          width={128}
          height={128}
          priority
          className="mx-auto size-28 sm:size-32"
        />
        <span className="mt-4 block font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          RoomyAI
        </span>
        <span className="mt-1 block text-sm text-ink-soft">ออกแบบห้องของคุณด้วย AI</span>

        <h1 className="mt-8 font-display text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          จัดห้องให้สวย
          <br />
          ด้วยของที่วางได้จริง
        </h1>

        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-ink-soft">
          อัปโหลดรูปห้องของคุณ ผมจะดูสไตล์ให้ วัดพื้นที่จากรูปจริง แล้วแนะนำเฟอร์นิเจอร์ที่
          วางลงไปแล้วไม่ล้นห้อง พร้อมวาดให้ดูเป็นรูปจำลองในห้องของคุณเอง
        </p>

        {/* The box that looks like the one in the chat. */}
        <div className="composer mx-auto mt-9 flex max-w-xl items-center gap-2 px-2 py-1.5">
          <span className="flex-1 px-2.5 py-2 text-sm text-ink-faint">
            ถามว่า “ห้องนั่งเล่น 3×4 เมตร งบ 30,000 วางโซฟาอะไรดี”
          </span>
          <Link
            href="/chat"
            aria-label="เริ่มแชท"
            className="btn-primary grid size-9 shrink-0 place-items-center rounded-full"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="size-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </Link>
        </div>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/chat" className="btn-primary px-6 py-3 text-sm">
            เริ่มจัดห้องของคุณ
          </Link>
          <a href="#how" className="btn-quiet px-5 py-3 text-sm text-ink-soft hover:text-ink">
            ดูว่าผมช่วยอะไรได้
          </a>
        </div>

        <ul className="mt-8 flex flex-wrap justify-center gap-2">
          {CAPABILITIES.map((capability) => (
            <li
              key={capability}
              className="rounded-full border border-line bg-tint/70 px-3.5 py-1.5 text-xs text-ink-soft"
            >
              {capability}
            </li>
          ))}
        </ul>

        <p className="mt-6 text-xs text-ink-faint">
          ไม่ต้องสมัครสมาชิก ไม่ต้องชำระเงิน — รูปที่อัปโหลดอยู่ในเซสชันของคุณเท่านั้น
        </p>
      </section>

      {/* ---- how it works, on a tinted band ---- */}
      <section id="how" className="border-y border-line-soft bg-tint">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-center font-display text-2xl font-semibold">ใช้งานสามขั้นตอน</h2>
          <ol className="mt-8 grid gap-5 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n} className="card p-6">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
                  {step.n}
                </span>
                <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- what it actually does ---- */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          <div>
            <h2 className="font-display text-2xl font-semibold">
              ต่างจากการ “ถามโมเดล” ตรง ๆ ยังไง
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              คำตอบทุกอย่างมาจากเครื่องมือที่อ่านฐานข้อมูลและกฎวัดขนาดจริง
              ไม่มีการเดาราคา เดาขนาด หรือคำนวณช่องว่างเอง
            </p>
            <Link
              href="/chat"
              className="btn-quiet mt-6 inline-block px-5 py-2.5 text-sm text-ink-soft hover:text-ink"
            >
              ลองดูสักห้อง
            </Link>
          </div>

          <ul className="grid gap-4 sm:grid-cols-2">
            {PROMISES.map((promise) => (
              <li key={promise.title} className="card p-5">
                <p className="flex items-start gap-2 text-sm font-semibold">
                  <span aria-hidden className="mt-0.5 text-ok">
                    ✓
                  </span>
                  {promise.title}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{promise.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className="border-t border-line-soft bg-tint/60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-xs text-ink-faint">
          <Brand iconSize={24} nameClass="text-sm font-semibold text-ink-soft" priority={false} />
          <span>ผู้ช่วยจัดวางเฟอร์นิเจอร์ลงในรูปห้องของคุณ</span>
          <Link
            href="/health"
            className="ml-auto underline underline-offset-4 hover:text-ink-soft"
          >
            สถานะระบบ
          </Link>
        </div>
      </footer>
    </main>
  );
}
