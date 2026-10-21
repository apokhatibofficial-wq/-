using System.Windows;
using System.Windows.Markup;
using System.Windows.Media;
using SharpVectors.Converters;
using SharpVectors.Renderers.Wpf;

namespace MedLink.Windows;

/// <summary>
/// `{local:Logo medlink-logo-white.svg}`: the original SVG file from Assets, read into a WPF drawing. An Image shows it
/// sized by the drawn content. The SVG viewer control misplaced drawings whose viewBox starts at a negative coordinate
/// (the KHATIB file), shifting the logo off its place; a drawing has no such offset. The files themselves are never changed.
/// </summary>
[MarkupExtensionReturnType(typeof(ImageSource))]
public sealed class LogoExtension(string file) : MarkupExtension
{
    private static readonly Dictionary<string, DrawingImage> Cache = [];

    public string File { get; } = file;

    public override object ProvideValue(IServiceProvider serviceProvider) => Load(File);

    public static DrawingImage Load(string file)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(file, out var cached)) return cached;
            var uri = new Uri("pack://application:,,,/Assets/" + file);
            using var stream = Application.GetResourceStream(uri)!.Stream;
            var reader = new FileSvgReader(new WpfDrawingSettings { IncludeRuntime = false, TextAsGeometry = true });
            var drawing = reader.Read(stream);
            var image = new DrawingImage(drawing);
            image.Freeze();
            Cache[file] = image;
            return image;
        }
    }
}
