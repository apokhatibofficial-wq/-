namespace MedLink.App;

/// <summary>
/// The splash sequence from SCREENS.md §3, as data. The WPF splash builds its storyboard from these values, and a test
/// checks them against the spec. "Reduced" follows Windows Settings › Accessibility › Animation effects.
/// </summary>
public sealed record SplashTimeline(
    int KhatibInMs, int KhatibFadeMs, int KhatibRiseMs, double KhatibFromY, double KhatibFromScale,
    int KhatibOutMs, double KhatibOutY, double KhatibOutScale,
    int MedlinkInMs, double MedlinkFromY,
    int FadeOutMs, int FadeOutDurationMs, int RemoveMs,
    (int AtMs, double Progress)[] Bar, bool Moves)
{
    /// <summary>cubic-bezier(.2,.7,.2,1)</summary>
    public static readonly (double X1, double Y1, double X2, double Y2) Ease = (0.2, 0.7, 0.2, 1);
    public const string Background = "#1a2d99";
    public const double BarWidth = 180, BarHeight = 3, BarBottom = 56, BarTrackOpacity = 0.18;

    public static readonly SplashTimeline Normal = new(
        KhatibInMs: 80, KhatibFadeMs: 520, KhatibRiseMs: 700, KhatibFromY: 10, KhatibFromScale: 0.96,
        KhatibOutMs: 1250, KhatibOutY: -14, KhatibOutScale: 1.02,
        MedlinkInMs: 1650, MedlinkFromY: 14,
        FadeOutMs: 2700, FadeOutDurationMs: 420, RemoveMs: 3150,
        Bar: [(80, 0.28), (1250, 0.62), (1650, 1.0)], Moves: true);

    /// <summary>Reduced motion: MEDLINK appears at 50 ms, the fade starts at 700 ms, removed at 1150 ms; nothing moves.</summary>
    public static readonly SplashTimeline Reduced = new(
        KhatibInMs: -1, KhatibFadeMs: 0, KhatibRiseMs: 0, KhatibFromY: 0, KhatibFromScale: 1,
        KhatibOutMs: -1, KhatibOutY: 0, KhatibOutScale: 1,
        MedlinkInMs: 50, MedlinkFromY: 0,
        FadeOutMs: 700, FadeOutDurationMs: 420, RemoveMs: 1150,
        Bar: [(50, 1.0)], Moves: false);

    public static SplashTimeline For(bool animationsOn) => animationsOn ? Normal : Reduced;
}
