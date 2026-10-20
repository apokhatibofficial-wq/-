using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace MedLink.Api.Forms;

/// <summary>Text in the three languages. Arabic is required to publish; EN/TR may be missing ("missing translation").</summary>
public sealed record I18n(string? Ar, string? En, string? Tr);

public sealed record FormOption(string Id, I18n Label);

/// <summary>One question, in the shape of designs/Form Builder.dc.html (id, type, req, label, opts).</summary>
public sealed record FormQuestion(string Id, string Type, bool Req, I18n Label, FormOption[]? Opts);

public sealed record FormSchemaDoc(FormQuestion[] Questions);

public static partial class FormSchema
{
    public static readonly string[] Types = ["short", "long", "single", "multi", "yesno", "date"];
    public const int MaxQuestions = 40, MaxOptions = 20, MaxLabel = 140, MaxOptionLabel = 80, MaxShort = 120, MaxLong = 1000;

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    [GeneratedRegex("^[a-z0-9]{1,24}$")]
    private static partial Regex IdFormat();

    public static bool HasOptions(string type) => type is "single" or "multi";

    /// <summary>Shape and size checks for a draft. Returns an error code, or null.</summary>
    public static string? ValidateStructure(FormSchemaDoc? doc)
    {
        if (doc?.Questions is null) return "FORM_INVALID";
        if (doc.Questions.Length > MaxQuestions) return "FORM_TOO_LARGE";
        var ids = new HashSet<string>();
        foreach (var q in doc.Questions)
        {
            if (q is null || q.Label is null || !IdFormat().IsMatch(q.Id ?? "") || !ids.Add(q.Id!)) return "FORM_INVALID";
            if (!Types.Contains(q.Type)) return "FORM_INVALID";
            if (TooLong(q.Label, MaxLabel)) return "FORM_INVALID";
            var opts = q.Opts ?? [];
            if (!HasOptions(q.Type) && opts.Length > 0) return "FORM_INVALID";
            if (opts.Length > MaxOptions) return "FORM_TOO_LARGE";
            var optIds = new HashSet<string>();
            foreach (var o in opts)
                if (o is null || o.Label is null || !IdFormat().IsMatch(o.Id ?? "") || !optIds.Add(o.Id!) || TooLong(o.Label, MaxOptionLabel))
                    return "FORM_INVALID";
        }
        return null;
    }

    private static bool TooLong(I18n t, int max) => (t.Ar?.Length ?? 0) > max || (t.En?.Length ?? 0) > max || (t.Tr?.Length ?? 0) > max;

    /// <summary>Publish blockers from the design: every question needs Arabic text; choice questions need ≥ 2 options with Arabic text.</summary>
    public static List<object> Blockers(FormSchemaDoc doc)
    {
        var list = new List<object>();
        for (var i = 0; i < doc.Questions.Length; i++)
        {
            var q = doc.Questions[i];
            if (string.IsNullOrWhiteSpace(q.Label.Ar)) list.Add(new { question = i + 1, code = "LABEL_AR_REQUIRED" });
            if (HasOptions(q.Type) && (q.Opts ?? []).Count(o => !string.IsNullOrWhiteSpace(o.Label.Ar)) < 2)
                list.Add(new { question = i + 1, code = "OPTIONS_REQUIRED" });
        }
        return list;
    }

    /// <summary>Removes options with no Arabic text before publishing (the design ignores blank option rows).</summary>
    public static FormSchemaDoc CleanForPublish(FormSchemaDoc doc) => new(doc.Questions.Select(q => q with
    {
        Label = Trim(q.Label),
        Opts = HasOptions(q.Type) ? (q.Opts ?? []).Where(o => !string.IsNullOrWhiteSpace(o.Label.Ar)).Select(o => o with { Label = Trim(o.Label) }).ToArray() : [],
    }).ToArray());

    private static I18n Trim(I18n t) => new(t.Ar?.Trim(), string.IsNullOrWhiteSpace(t.En) ? null : t.En.Trim(), string.IsNullOrWhiteSpace(t.Tr) ? null : t.Tr.Trim());

    /// <summary>[added, edited, removed, reordered] — the same comparison as the prototype.</summary>
    public static int[] Diff(FormSchemaDoc draft, FormSchemaDoc? live)
    {
        var baseQs = live?.Questions ?? [];
        var bm = baseQs.ToDictionary(q => q.Id, q => JsonSerializer.Serialize(q, Json));
        var dm = draft.Questions.Select(q => q.Id).ToHashSet();
        var added = draft.Questions.Count(q => !bm.ContainsKey(q.Id));
        var edited = draft.Questions.Count(q => bm.TryGetValue(q.Id, out var b) && b != JsonSerializer.Serialize(q, Json));
        var removed = baseQs.Count(q => !dm.Contains(q.Id));
        var common = draft.Questions.Where(q => bm.ContainsKey(q.Id)).Select(q => q.Id);
        var bc = baseQs.Where(q => dm.Contains(q.Id)).Select(q => q.Id);
        return [added, edited, removed, common.SequenceEqual(bc) ? 0 : 1];
    }

    /// <summary>
    /// Validates a patient's answers against one published version, on the server.
    /// Returns the normalised answers to store, or an error code.
    /// </summary>
    public static (Dictionary<string, JsonElement>? Answers, string? Error, string? QuestionId) ValidateAnswers(FormSchemaDoc doc, Dictionary<string, JsonElement>? given)
    {
        given ??= [];
        var known = doc.Questions.ToDictionary(q => q.Id);
        if (given.Keys.Any(k => !known.ContainsKey(k))) return (null, "ANSWER_UNKNOWN_QUESTION", given.Keys.First(k => !known.ContainsKey(k)));
        var output = new Dictionary<string, JsonElement>();
        foreach (var q in doc.Questions)
        {
            var has = given.TryGetValue(q.Id, out var v) && !IsEmpty(v);
            if (!has)
            {
                if (q.Req) return (null, "ANSWER_REQUIRED", q.Id);
                continue;
            }
            var opts = (q.Opts ?? []).Select(o => o.Id).ToHashSet();
            var ok = q.Type switch
            {
                "short" => v.ValueKind == JsonValueKind.String && v.GetString()!.Trim().Length <= MaxShort,
                "long" => v.ValueKind == JsonValueKind.String && v.GetString()!.Trim().Length <= MaxLong,
                "single" => v.ValueKind == JsonValueKind.String && opts.Contains(v.GetString()!),
                "yesno" => v.ValueKind == JsonValueKind.String && v.GetString() is "yes" or "no",
                "date" => v.ValueKind == JsonValueKind.String && DateOnly.TryParseExact(v.GetString(), "yyyy-MM-dd", out _),
                "multi" => v.ValueKind == JsonValueKind.Array && v.EnumerateArray().All(x => x.ValueKind == JsonValueKind.String && opts.Contains(x.GetString()!))
                           && v.EnumerateArray().Select(x => x.GetString()).Distinct().Count() == v.GetArrayLength(),
                _ => false,
            };
            if (!ok) return (null, "ANSWER_INVALID", q.Id);
            output[q.Id] = v.ValueKind == JsonValueKind.String ? JsonSerializer.SerializeToElement(v.GetString()!.Trim()) : v.Clone();
        }
        return (output, null, null);
    }

    private static bool IsEmpty(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => true,
        JsonValueKind.String => string.IsNullOrWhiteSpace(v.GetString()),
        JsonValueKind.Array => v.GetArrayLength() == 0,
        _ => false,
    };
}
