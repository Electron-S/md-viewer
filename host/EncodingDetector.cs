using System;
using System.Text;

namespace MdViewer
{
    public sealed class DecodeResult
    {
        public string Text = "";
        /// <summary>utf-8 | utf-16le | utf-16be | cp949</summary>
        public string Encoding = "utf-8";
        public bool HasBom;
        /// <summary>잘못된 바이트를 대체 문자로 바꿨는지 (NFR-ENC-02)</summary>
        public bool Warning;
        public bool Binary;
    }

    /// <summary>인코딩 판별 (SDD 8.3). 순서: BOM → 바이너리 → 엄격 UTF-8 → 엄격 CP949 → UTF-8 대체.</summary>
    public static class EncodingDetector
    {
        const int BinaryScanBytes = 8000;

        static Encoding Strict(string name)
        {
            switch (name)
            {
                case "utf-8": return new UTF8Encoding(false, true);
                case "utf-16le": return new UnicodeEncoding(false, false, true);
                case "utf-16be": return new UnicodeEncoding(true, false, true);
                case "cp949": return Encoding.GetEncoding(949, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
            }
            throw new BridgeException("EINVAL", Strings.UnsupportedEncoding(name));
        }

        static Encoding Loose(string name)
        {
            switch (name)
            {
                case "utf-8": return new UTF8Encoding(false, false);
                case "utf-16le": return new UnicodeEncoding(false, false, false);
                case "utf-16be": return new UnicodeEncoding(true, false, false);
                case "cp949": return Encoding.GetEncoding(949, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback);
            }
            throw new BridgeException("EINVAL", Strings.UnsupportedEncoding(name));
        }

        static bool StartsWith(byte[] b, params byte[] prefix)
        {
            if (b.Length < prefix.Length) return false;
            for (int i = 0; i < prefix.Length; i++) if (b[i] != prefix[i]) return false;
            return true;
        }

        static int BomLength(byte[] b, string name)
        {
            switch (name)
            {
                case "utf-8": return StartsWith(b, 0xEF, 0xBB, 0xBF) ? 3 : 0;
                case "utf-16le": return StartsWith(b, 0xFF, 0xFE) ? 2 : 0;
                case "utf-16be": return StartsWith(b, 0xFE, 0xFF) ? 2 : 0;
            }
            return 0;
        }

        public static bool LooksBinary(byte[] b)
        {
            int n = Math.Min(b.Length, BinaryScanBytes);
            for (int i = 0; i < n; i++) if (b[i] == 0) return true;
            return false;
        }

        public static DecodeResult Detect(byte[] b)
        {
            if (StartsWith(b, 0xEF, 0xBB, 0xBF)) return DecodeAs(b, "utf-8");
            if (StartsWith(b, 0xFF, 0xFE)) return DecodeAs(b, "utf-16le");
            if (StartsWith(b, 0xFE, 0xFF)) return DecodeAs(b, "utf-16be");
            if (LooksBinary(b)) return new DecodeResult { Binary = true };
            try
            {
                return new DecodeResult { Text = Strict("utf-8").GetString(b), Encoding = "utf-8" };
            }
            catch (DecoderFallbackException) { }
            try
            {
                string text = Strict("cp949").GetString(b);
                if (!HasUndefinedCp949(text)) return new DecodeResult { Text = text, Encoding = "cp949" };
            }
            catch (DecoderFallbackException) { }
            return new DecodeResult { Text = Loose("utf-8").GetString(b), Encoding = "utf-8", Warning = true };
        }

        /// <summary>
        /// .NET의 949 디코더는 정의되지 않은 단일 바이트(0x80, 0xFF 등)를 예외 없이 C1 제어 문자나
        /// 사용자 정의 영역 문자로 바꾼다. 이런 문자가 나오면 CP949 문서가 아니라고 본다.
        /// </summary>
        static bool HasUndefinedCp949(string text)
        {
            foreach (char c in text)
            {
                if ((c >= '\u0080' && c <= '\u009F') || (c >= '' && c <= '')) return true;
            }
            return false;
        }

        /// <summary>지정한 인코딩으로 읽는다 (FR-INFO-02). 잘못된 바이트는 대체 문자로 바꾸고 경고를 켠다.</summary>
        public static DecodeResult DecodeAs(byte[] b, string name)
        {
            int bom = BomLength(b, name);
            var r = new DecodeResult { Encoding = name, HasBom = bom > 0 };
            try
            {
                r.Text = Strict(name).GetString(b, bom, b.Length - bom);
            }
            catch (DecoderFallbackException)
            {
                r.Text = Loose(name).GetString(b, bom, b.Length - bom);
                r.Warning = true;
            }
            catch (ArgumentException)
            {
                // UTF-16에서 홀수 바이트 등
                r.Text = Loose(name).GetString(b, bom, b.Length - bom);
                r.Warning = true;
            }
            return r;
        }

        public static string DetectEol(string text)
        {
            int crlf = 0, lf = 0, cr = 0;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r')
                {
                    if (i + 1 < text.Length && text[i + 1] == '\n') { crlf++; i++; }
                    else cr++;
                }
                else if (c == '\n') lf++;
            }
            int kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
            if (kinds == 0) return "None";
            if (kinds > 1) return "Mixed";
            return crlf > 0 ? "CRLF" : (lf > 0 ? "LF" : "CR");
        }
    }
}
