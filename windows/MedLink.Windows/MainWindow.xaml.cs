using System.ComponentModel;
using System.Windows;
using MedLink.App;
using MedLink.Windows.Views;

namespace MedLink.Windows;

public partial class MainWindow : Window
{
    private readonly AppController _app;

    public MainWindow(AppController app, bool startSplash = true)
    {
        InitializeComponent();
        _app = app;
        DataContext = app;
        ApplyDirection();
        app.PropertyChanged += OnAppChanged;
        // Maximized: two overlapping squares (restore), otherwise one square.
        StateChanged += (_, _) => MaxIcon.Data = System.Windows.Media.Geometry.Parse(WindowState == WindowState.Maximized
            ? "M2.5,0.5 H9.5 V7.5 M0.5,2.5 H7.5 V9.5 H0.5 Z" : "M0.5,0.5 H9.5 V9.5 H0.5 Z");
        Closing += OnClosing;
        if (startSplash) ShowScreen();
    }

    internal SplashView? Splash => Host.Content as SplashView;

    private void OnAppChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(AppController.Screen) or nameof(AppController.Main)) ShowScreen();
        if (e.PropertyName is "" or nameof(AppController.Rtl)) ApplyDirection();
    }

    private void ApplyDirection() => ((FrameworkElement)Host).FlowDirection = _app.Rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;

    internal void ShowScreen()
    {
        Host.Content = _app.Screen switch
        {
            Screen.Splash => Host.Content as SplashView ?? new SplashView(_app),
            Screen.SignIn => Host.Content as SignInView ?? new SignInView(_app.SignIn),
            _ when _app.Main is { } m => Host.Content is MainView mv && mv.DataContext == m ? mv : new MainView(m),
            _ => Host.Content,
        };
    }

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        // Stop the background sync cleanly; the outbox is already on disk.
        if (_app.Main is { } m) { _app.PropertyChanged -= OnAppChanged; await m.StopAsync(); }
    }

    private void Minimize(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Maximize(object sender, RoutedEventArgs e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void CloseWindow(object sender, RoutedEventArgs e) => Close();
}
