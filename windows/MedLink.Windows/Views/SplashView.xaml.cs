using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;
using MedLink.App;

namespace MedLink.Windows.Views;

/// <summary>cubic-bezier(x1,y1,x2,y2) as a WPF easing (CSS timing function).</summary>
public sealed class CubicBezierEase : EasingFunctionBase
{
    public double X1 { get; set; } = 0.2;
    public double Y1 { get; set; } = 0.7;
    public double X2 { get; set; } = 0.2;
    public double Y2 { get; set; } = 1;

    protected override double EaseInCore(double t)
    {
        // Solve x(s) = t for s by Newton's method, then return y(s).
        var s = t;
        for (var i = 0; i < 8; i++)
        {
            var x = Bez(s, X1, X2) - t;
            var dx = 3 * (1 - s) * (1 - s) * X1 + 6 * (1 - s) * s * (X2 - X1) + 3 * s * s * (1 - X2);
            if (Math.Abs(dx) < 1e-6) break;
            s = Math.Clamp(s - x / dx, 0, 1);
        }
        return Bez(s, Y1, Y2);
    }

    private static double Bez(double s, double p1, double p2) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
    protected override Freezable CreateInstanceCore() => new CubicBezierEase();
}

/// <summary>
/// The splash (SCREENS.md §3), built from <see cref="SplashTimeline"/>. Follows Windows' "Animation effects" setting
/// (SystemParameters.ClientAreaAnimation = prefers-reduced-motion). The window uses the reduced variant when animations are off.
/// </summary>
public partial class SplashView : UserControl
{
    private readonly AppController _app;
    private readonly Storyboard _story = new();
    private readonly SplashTimeline _t;

    public SplashView(AppController app, bool? animations = null)
    {
        InitializeComponent();
        _app = app;
        _t = SplashTimeline.For(animations ?? SystemParameters.ClientAreaAnimation);
        Build();
        Loaded += (_, _) => { if (!Frozen) _story.Begin(this, true); };
    }

    /// <summary>Set by the screenshot run to show one frame instead of playing.</summary>
    internal bool Frozen { get; set; }

    internal void ShowFrame(int ms)
    {
        Frozen = true;
        _story.Begin(this, true);
        _story.Seek(this, TimeSpan.FromMilliseconds(ms), TimeSeekOrigin.BeginTime);
        _story.Pause(this);
    }

    private static TimeSpan Ms(double ms) => TimeSpan.FromMilliseconds(ms);

    private void Add(Timeline a, DependencyObject target, string property)
    {
        Storyboard.SetTarget(a, target);
        Storyboard.SetTargetProperty(a, new PropertyPath(property));
        _story.Children.Add(a);
    }

    private void Build()
    {
        var ease = new CubicBezierEase();
        if (_t.KhatibInMs >= 0)
        {
            Add(new DoubleAnimation(0, 1, Ms(_t.KhatibFadeMs)) { BeginTime = Ms(_t.KhatibInMs), EasingFunction = ease }, Khatib, "Opacity");
            Add(new DoubleAnimation(_t.KhatibFromY, 0, Ms(_t.KhatibRiseMs)) { BeginTime = Ms(_t.KhatibInMs), EasingFunction = ease }, KhatibMove, "Y");
            Add(new DoubleAnimation(_t.KhatibFromScale, 1, Ms(_t.KhatibRiseMs)) { BeginTime = Ms(_t.KhatibInMs), EasingFunction = ease }, KhatibScale, "ScaleX");
            Add(new DoubleAnimation(_t.KhatibFromScale, 1, Ms(_t.KhatibRiseMs)) { BeginTime = Ms(_t.KhatibInMs), EasingFunction = ease }, KhatibScale, "ScaleY");
            var outDur = Ms(_t.MedlinkInMs - _t.KhatibOutMs);
            Add(new DoubleAnimation(1, 0, outDur) { BeginTime = Ms(_t.KhatibOutMs), EasingFunction = ease }, Khatib, "Opacity");
            Add(new DoubleAnimation(0, _t.KhatibOutY, outDur) { BeginTime = Ms(_t.KhatibOutMs), EasingFunction = ease }, KhatibMove, "Y");
            Add(new DoubleAnimation(1, _t.KhatibOutScale, outDur) { BeginTime = Ms(_t.KhatibOutMs), EasingFunction = ease }, KhatibScale, "ScaleX");
            Add(new DoubleAnimation(1, _t.KhatibOutScale, outDur) { BeginTime = Ms(_t.KhatibOutMs), EasingFunction = ease }, KhatibScale, "ScaleY");
        }
        if (_t.Moves)
        {
            Add(new DoubleAnimation(0, 1, Ms(520)) { BeginTime = Ms(_t.MedlinkInMs), EasingFunction = ease }, Medlink, "Opacity");
            Add(new DoubleAnimation(_t.MedlinkFromY, 0, Ms(700)) { BeginTime = Ms(_t.MedlinkInMs), EasingFunction = ease }, MedlinkMove, "Y");
        }
        else Add(new DoubleAnimation(0, 1, TimeSpan.Zero) { BeginTime = Ms(_t.MedlinkInMs) }, Medlink, "Opacity");
        double previous = 0;
        foreach (var (at, progress) in _t.Bar)
        {
            Add(new DoubleAnimation(previous * 180, progress * 180, Ms(_t.Moves ? 900 : 0)) { BeginTime = Ms(at), EasingFunction = new QuadraticEase() }, Bar, "Width");
            previous = progress;
        }
        Add(new DoubleAnimation(1, 0, Ms(_t.FadeOutDurationMs)) { BeginTime = Ms(_t.FadeOutMs) }, Root, "Opacity");
        _story.Duration = new Duration(Ms(_t.RemoveMs));
        _story.Completed += async (_, _) => { if (!Frozen) await _app.SplashDoneAsync(); };
    }
}
