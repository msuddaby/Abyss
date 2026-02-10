using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddPersistentChatToChannel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "PersistentChat",
                table: "Channels",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PersistentChat",
                table: "Channels");
        }
    }
}
