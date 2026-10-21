using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;
using MedLink.App;

namespace MedLink.Windows;

public sealed class BoolToVisibility : IValueConverter
{
    public bool Invert { get; set; }
    public object Convert(object value, Type t, object? p, CultureInfo c) => (value is true) ^ Invert ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object value, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}

/// <summary>Visible when the text is not empty; ConverterParameter=invert shows a placeholder while it is empty.</summary>
public sealed class StringToVisibility : IValueConverter
{
    public object Convert(object value, Type t, object? p, CultureInfo c) =>
        (value is string { Length: > 0 }) ^ (p as string == "invert") ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object value, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}

/// <summary>True when the value equals the parameter (nav page index, selected chip).</summary>
public sealed class EqualsConverter : IValueConverter
{
    public object Convert(object value, Type t, object? p, CultureInfo c) => string.Equals(value?.ToString(), p?.ToString(), StringComparison.Ordinal);
    public object ConvertBack(object value, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}

/// <summary>Status chip colours (same as the hospital web).</summary>
public sealed class StatusBrush : IValueConverter
{
    public string Part { get; set; } = "Background";
    private static SolidColorBrush B(string hex) { var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); b.Freeze(); return b; }
    private static readonly Dictionary<string, (SolidColorBrush Bg, SolidColorBrush Fg)> Map = new()
    {
        ["waiting"] = (B("#eef1fc"), B("#1a2d99")), ["arrived"] = (B("#e7f6ee"), B("#13795b")),
        ["no_show"] = (B("#fff4e5"), B("#7a4300")), ["cancelled"] = (B("#fdecea"), B("#8a1c12")),
    };
    public object Convert(object value, Type t, object? p, CultureInfo c)
    {
        var (bg, fg) = Map.GetValueOrDefault(value as string ?? "", Map["waiting"]);
        return Part == "Background" ? bg : fg;
    }
    public object ConvertBack(object value, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}

/// <summary>Sync pill: green online, amber offline, blue syncing.</summary>
public sealed class ConnectionBrush : IValueConverter
{
    public string Part { get; set; } = "Background";
    private static SolidColorBrush B(string hex) { var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); b.Freeze(); return b; }
    public object Convert(object value, Type t, object? p, CultureInfo c)
    {
        var state = value switch { Connection x => x, true => Connection.Online, false => Connection.Offline, _ => Connection.Syncing };
        return (state, Part) switch
        {
            (Connection.Online, "Background") => B("#e7f6ee"), (Connection.Online, "Foreground") => B("#0d5a43"), (Connection.Online, _) => B("#13795b"),
            (Connection.Offline, "Background") => B("#fff4e5"), (Connection.Offline, "Foreground") => B("#6b4a00"), (Connection.Offline, _) => B("#e8a317"),
            (_, "Background") => B("#eef1fc"), (_, "Foreground") => B("#1a2d99"), _ => B("#2b41c5"),
        };
    }
    public object ConvertBack(object value, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}
