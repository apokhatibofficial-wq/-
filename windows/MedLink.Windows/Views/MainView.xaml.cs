using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using MedLink.App;

namespace MedLink.Windows.Views;

public partial class MainView : UserControl
{
    private readonly MainViewModel _vm;
    private readonly DispatcherTimer _toastTimer = new() { Interval = TimeSpan.FromSeconds(4) };
    private bool _selecting;

    public MainView(MainViewModel vm)
    {
        InitializeComponent();
        DataContext = _vm = vm;
        vm.PropertyChanged += OnVm;
        vm.Dashboard.PropertyChanged += OnDashboard;
        _toastTimer.Tick += (_, _) => { _toastTimer.Stop(); ToastBox.Visibility = Visibility.Collapsed; };
        ShowPage();
    }

    private void OnVm(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(MainViewModel.Page) or "") ShowPage();
        if (e.PropertyName == nameof(MainViewModel.ToastId) && _vm.Toast.Length > 0)
        {
            ToastBox.Visibility = Visibility.Visible;
            _toastTimer.Stop();
            _toastTimer.Start();
        }
    }

    /// <summary>Keeps the table's selection in step with the detail panel (closing it, or a new list after a sync).</summary>
    private void OnDashboard(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is not ("" or nameof(DashboardViewModel.Rows) or nameof(DashboardViewModel.HasSelection))) return;
        _selecting = true;
        Table.SelectedItem = _vm.Dashboard.HasSelection ? _vm.Dashboard.Rows.FirstOrDefault(r => r.Ref == _vm.Dashboard.DRef) : null;
        _selecting = false;
    }

    private void ShowPage()
    {
        Appointments.Visibility = _vm.Page == 0 ? Visibility.Visible : Visibility.Collapsed;
        FindPage.Visibility = _vm.Page == 1 ? Visibility.Visible : Visibility.Collapsed;
        SyncPageView.Visibility = _vm.Page == 2 ? Visibility.Visible : Visibility.Collapsed;
        SettingsPageView.Visibility = _vm.Page == 3 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnRowSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_selecting || Table.SelectedItem is not BookingRow row) return;
        _vm.Dashboard.SelectCommand.Execute(row);
    }

    /// <summary>Narrow window (below 1100px): nav 168px, logo 104px, detail panel 290px.</summary>
    private void OnSize(object sender, SizeChangedEventArgs e)
    {
        var narrow = Window.GetWindow(this) is { } w ? w.ActualWidth < 1100 : e.NewSize.Width < 1100;
        NavColumn.Width = new GridLength(narrow ? 168 : 208);
        NavLogo.Width = narrow ? 104 : 128;
        Detail.Width = narrow ? 290 : 340;
    }
}
